#!/usr/bin/env bash
# Ships the working tree to the live server and rebuilds the container.
#
# Two things are deliberately never copied. The server's .env holds
# SESSION_SECRET, and replacing it would sign every user out. The avatar artwork
# is downloaded and normalized inside the image at build time, so shipping the
# local copy would only send 1.8MB the build throws away.
set -euo pipefail

# The origin IP is deliberately not written down here. Cloudflare exists to hide
# it, and this file is public, so it comes from the environment:
#
#   PLUGDJ_HOST=root@<origin-ip> ./scripts/deploy.sh
host="${PLUGDJ_HOST:?set PLUGDJ_HOST to user@origin-ip, e.g. root@203.0.113.10}"
dir="${PLUGDJ_DIR:-/opt/plugdj}"
compose="-f docker-compose.yml -f docker-compose.tls.yml"

rsync -az --delete --no-perms --no-owner --no-group \
  --exclude .git/ \
  --exclude .cursor/ \
  --exclude node_modules/ \
  --exclude data/ \
  --exclude .env \
  --exclude .DS_Store \
  --exclude assets/avatars/ \
  ./ "$host:$dir/"

ssh "$host" "cd '$dir' && docker compose $compose up -d --build"

# Compose leaves Caddy alone when only the mounted Caddyfile changed, and Caddy
# does not watch the file, so a config edit needs an explicit reload. This is
# graceful, unlike restarting the container.
ssh "$host" "cd '$dir' && docker compose $compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile" \
  || echo 'deploy: warning, caddy reload failed; it is still serving its previous config'

site_ip="${host#*@}"

# The hostname lives in the server's .env, which is deliberately never copied
# from here, so ask the server what it is rather than keeping a second copy.
site_host=$(ssh "$host" "cd '$dir' && sed -n 's/^SITE_HOST=//p' .env" | tr -d '\r"' | tail -1)
if [ -z "$site_host" ]; then
  echo 'deploy: SITE_HOST is not set in the server .env'
  exit 1
fi

# A recreated container accepts connections a moment before it can serve, so
# ask for a real page and let curl retry rather than sleeping a fixed guess.
retry='--retry 15 --retry-delay 2 --retry-all-errors --max-time 90'

# Two hops, checked separately, because they fail for unrelated reasons and a
# single red light would not say which.
#
# The origin: the hostname in SNI, sent straight at our own IP, bypassing
# Cloudflare. This proves Caddy and the app are healthy. -k belongs here and
# nowhere else, since this hop carries Caddy's internal certificate, which is
# what Cloudflare's "Full" mode expects and what no public root store knows.
origin=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "${site_host}:443:${site_ip}" \
  $retry "https://${site_host}/" || echo 000)

# The public address, all the way through Cloudflare. No -k: this is the
# certificate a browser has to accept. A 526 here against a healthy origin
# means Cloudflare is set to "Full (strict)" and wants a publicly trusted
# certificate on the hop it was told not to verify.
public=$(curl -s -o /dev/null -w '%{http_code}' $retry "https://${site_host}/" || echo 000)

echo "deploy: origin ${site_ip} as ${site_host} ${origin}, https://${site_host}/ ${public}"

# The bare IP is retired, not load balanced, so its state is worth printing but
# not worth failing on: 000 is the goal, because YouTube will not authorise
# label-owned videos for a page served from an IP address.
ip_http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${site_ip}/" || true)
ip_https=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "https://${site_ip}/" || true)
echo "deploy: bare IP http ${ip_http}, https ${ip_https} (000 means closed, which is intended)"

[ "$origin" = 200 ] && [ "$public" = 200 ]

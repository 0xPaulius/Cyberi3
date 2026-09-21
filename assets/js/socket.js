// Socket connection plus clock synchronisation.
//
// Track start times are server timestamps, so a client whose clock is off would
// seek to the wrong place. We estimate the offset the way NTP does and keep the
// sample with the lowest round trip, which is the least distorted one.

export const socket = io({ autoConnect: false });

let offset = 0;
let bestRtt = Infinity;

async function probe() {
  return new Promise((resolve) => {
    const sent = Date.now();
    socket.timeout(4000).emit('time:sync', sent, (error, reply) => {
      if (error || !reply) return resolve();
      const received = Date.now();
      const rtt = received - sent;
      if (rtt < bestRtt) {
        bestRtt = rtt;
        // Assume the reply took half the round trip to reach us.
        offset = reply.serverNow + rtt / 2 - received;
      }
      resolve();
    });
  });
}

export async function syncClock(samples = 5) {
  for (let i = 0; i < samples; i += 1) {
    await probe();
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Current time on the server's clock. */
export function serverNow() {
  return Date.now() + offset;
}

export function clockQuality() {
  return { offset: Math.round(offset), rtt: Number.isFinite(bestRtt) ? bestRtt : null };
}

socket.on('connect', () => {
  bestRtt = Infinity;
  syncClock();
});

// Re-measure periodically; laptops that sleep come back with a drifted clock.
setInterval(() => {
  if (socket.connected) probe();
}, 30000);

/** Promise-based emit for events that reply with {ok} or {error}. */
export function request(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(6000).emit(event, payload, (error, reply) => {
      if (error) return resolve({ error: 'The room did not respond' });
      resolve(reply ?? {});
    });
  });
}

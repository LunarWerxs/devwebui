// ───────────────────────────────────────────────────────────────────────────────
// Port helpers back two shipped behaviors: the daemon "hops" to the next free port
// instead of crashing on a busy one (findFreePort), and the launcher probes whether
// an instance is already listening (isPortListening). Exercised against real local
// sockets so the cross-platform bind/connect path is what's actually tested.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import net from "node:net";
import { findFreePort, isPortListening } from "../server/src/ports";

// Bind with the SAME defaults findFreePort uses (no explicit host) so an occupied
// port genuinely collides with its bind attempt.
function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, () => resolve(srv));
  });
}
function close(srv: net.Server): Promise<void> {
  return new Promise((r) => srv.close(() => r()));
}
function portOf(srv: net.Server): number {
  return (srv.address() as net.AddressInfo).port;
}

test("isPortListening reflects whether something is bound", async () => {
  const probe = await listenOn(0); // OS picks a free port
  const port = portOf(probe);
  await close(probe);
  expect(await isPortListening(port)).toBe(false); // nothing there now

  const srv = await listenOn(port);
  try {
    expect(await isPortListening(port)).toBe(true);
  } finally {
    await close(srv);
  }
});

test("findFreePort returns the preferred port when it is free", async () => {
  const probe = await listenOn(0);
  const port = portOf(probe);
  await close(probe); // free again
  expect(await findFreePort(port)).toBe(port);
});

test("findFreePort steps past an occupied port to the next free one", async () => {
  const srv = await listenOn(0);
  const port = portOf(srv);
  try {
    const got = await findFreePort(port);
    expect(got).toBeGreaterThan(port); // hopped over the busy port to a bindable one
  } finally {
    await close(srv);
  }
});

import { expect, test } from "@playwright/test";
import http from "node:http";
import { AddressInfo, Socket } from "node:net";

// PLAN §12: "SSE resilience: disconnect and verify reconnection".
//
// Neither context.setOffline() nor page.route() tears down an EventSource response that
// is already streaming, so the browser talks to the app through a tiny pass-through proxy
// owned by the test. "Cutting the cable" destroys the live stream sockets and refuses new
// stream connections; restoring it lets EventSource reconnect for real.

const target = new URL(process.env.BASE_URL || "http://localhost:8000");

function startProxy() {
  let down = false;
  const streamSockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const isStream = (req.url || "").startsWith("/api/stream/");
    if (isStream && down) {
      req.socket.destroy();
      return;
    }
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    if (isStream) {
      streamSockets.add(req.socket);
      req.socket.on("close", () => {
        streamSockets.delete(req.socket);
        upstream.destroy();
      });
    }
    req.pipe(upstream);
  });

  return {
    server,
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    cut() {
      down = true;
      for (const s of streamSockets) s.destroy();
      streamSockets.clear();
    },
    restore() {
      down = false;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("connection indicator reflects a dropped stream and recovers", async ({ page }) => {
  const proxy = startProxy();
  const proxyUrl = await proxy.listen();
  try {
    await page.goto(proxyUrl + "/");
    const status = page.getByTestId("connection-status");
    await expect(status).toHaveAttribute("data-status", "connected", { timeout: 15_000 });

    proxy.cut();
    await expect(status).toHaveAttribute("data-status", /^(reconnecting|disconnected)$/, {
      timeout: 15_000,
    });

    // Stays down while the stream is unreachable.
    await page.waitForTimeout(2_000);
    await expect(status).not.toHaveAttribute("data-status", "connected");

    proxy.restore();
    await expect(status).toHaveAttribute("data-status", "connected", { timeout: 30_000 });

    // Prices flow again after reconnecting.
    const prices = page.locator('[data-testid^="price-"]');
    const before = await prices.allTextContents();
    await expect
      .poll(async () => (await prices.allTextContents()).some((p, i) => p !== before[i]), {
        timeout: 15_000,
      })
      .toBe(true);
  } finally {
    await proxy.close();
  }
});

// VM-04: hosted Postgres connections are encrypted and verify the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { TLSSocket } from "node:tls";
import postgres from "postgres";
const { databaseTls } = await import("../src/lib/db");

const cert = readFileSync("tests/fixtures/tls/server-cert.pem", "utf8");
const key = readFileSync("tests/fixtures/tls/server-key.pem", "utf8");
// The URL shape documented in .env.example (Supabase transaction pooler).
const pooler =
  "postgresql://postgres.abcdefgh:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

test("hosted URLs get verified TLS, whatever sslmode they carry", () => {
  for (const url of [pooler, `${pooler}?sslmode=require`])
    assert.deepEqual(databaseTls(url, { DATABASE_CA_CERT: cert }), {
      rejectUnauthorized: true,
      ca: cert.trim(),
    });
  // A CA pasted into one line with \n escapes still works.
  assert.equal(
    (
      databaseTls(pooler, {
        DATABASE_CA_CERT: cert.replace(/\n/g, "\\n"),
      }) as { ca: string }
    ).ca,
    cert.trim(),
  );
  assert.deepEqual(databaseTls(`${pooler}?sslrootcert=system`, {}), {
    rejectUnauthorized: true,
  });
});

test("hosted URLs without a trusted CA or with weak sslmode fail closed", () => {
  assert.throws(() => databaseTls(pooler, {}), /DATABASE_CA_CERT/);
  for (const mode of ["disable", "allow", "prefer"])
    assert.throws(
      () =>
        databaseTls(`${pooler}?sslmode=${mode}`, { DATABASE_CA_CERT: cert }),
      /verified TLS/,
    );
});

test("only a database on this machine may skip TLS", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(databaseTls(`postgres://u@${host}:5432/db`, {}), false);
    assert.deepEqual(
      databaseTls(`postgres://u@${host}:5432/db?sslmode=verify-full`, {
        DATABASE_CA_CERT: cert,
      }),
      { rejectUnauthorized: true, ca: cert.trim() },
    );
  }
});

// A stand-in server that answers Postgres's SSL request and completes a TLS
// handshake with the self-signed test certificate, then hangs up.
async function tlsServer() {
  let handshakes = 0;
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, key, cert });
      secure.on("secure", () => {
        handshakes++;
        secure.destroy();
      });
      secure.on("error", () => {});
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    handshakes: () => handshakes,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
// Connects the way the hosted driver would, with the TLS settings computed
// for a remote URL, to the stand-in server.
async function connect(port: number, url: string, env: Record<string, string>) {
  const sql = postgres({
    host: "127.0.0.1",
    port,
    user: "u",
    database: "db",
    ssl: databaseTls(url, env),
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    await sql`select 1`;
    return null;
  } catch (error) {
    return error as Error & { code?: string };
  } finally {
    await sql.end({ timeout: 0 });
  }
}

test("an untrusted server certificate is refused before any query is sent", async () => {
  const server = await tlsServer();
  try {
    // The system's roots don't trust the self-signed certificate.
    const refused = await connect(
      server.port,
      `${pooler}?sslrootcert=system`,
      {},
    );
    assert.ok(refused);
    assert.match(
      `${refused.code} ${refused.message}`,
      /SELF_SIGNED|self.signed|unable to verify/i,
    );
    assert.equal(server.handshakes(), 0);
    // Trusting it as the CA lets the handshake complete.
    const trusted = await connect(server.port, pooler, {
      DATABASE_CA_CERT: cert,
    });
    assert.ok(trusted);
    assert.doesNotMatch(trusted.message, /self.signed|certificate/i);
    // (The client retries once after the stand-in hangs up.)
    assert.ok(server.handshakes() >= 1);
  } finally {
    await server.close();
  }
});

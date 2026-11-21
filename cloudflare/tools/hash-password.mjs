// Makes DASHBOARD_PASSWORD_HASH for the Worker (100,000 PBKDF2 iterations, the Workers maximum).
//   node tools/hash-password.mjs            (asks for the password; nothing is echoed or stored)
//   node tools/hash-password.mjs --generate (creates a random password and prints both)
import { createInterface } from "node:readline";
import { hashPassword } from "../src/auth.js";

if (process.argv.includes("--generate")) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const password = Buffer.from(bytes).toString("base64url");
  console.log(JSON.stringify({ password, hash: await hashPassword(password) }));
} else {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = () => {};
  process.stderr.write("New dashboard password (12+ characters): ");
  rl.question("", async (pw) => { rl.close(); process.stderr.write("\n"); console.log(await hashPassword(pw)); });
}

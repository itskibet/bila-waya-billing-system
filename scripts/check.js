// Syntax-checks every backend .js file without starting the server or touching the database.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dirs = ["config", "middleware", "routes", "services", "utils", "scripts", "tests"];
const files = [path.join(root, "index.js")];

for (const dir of dirs) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) if (name.endsWith(".js")) files.push(path.join(full, name));
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}\n${error.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);

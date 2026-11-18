// Creates (or resets the password of) an admin account.
//
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run admin:create
//   npm run admin:create -- you@example.com 'a-long-password'
//
// Nothing is hardcoded: you must supply the credentials yourself.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const prisma = require("../config/prismaClient");

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || "";

async function main() {
  if (!email || !password) {
    console.error("Provide an email and password (see the comment at the top of this file).");
    process.exit(1);
  }
  if (password.length < 10) {
    console.error("Password must be at least 10 characters.");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const admin = await prisma.admin.upsert({
    where: { email },
    create: { email, password: hash },
    update: { password: hash },
  });
  console.log(`Admin ready: ${admin.email}`);
}

main()
  .catch((error) => {
    console.error("Failed to create admin:", error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

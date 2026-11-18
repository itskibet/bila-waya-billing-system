const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prismaClient");
const { config } = require("../config/env");

const router = express.Router();

// Compared against when the email does not exist, so a missing account takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      return res.status(400).json({ success: false, error: "Email and password are required" });
    }

    const admin = await prisma.admin.findUnique({ where: { email: email.trim().toLowerCase() } });
    const matches = await bcrypt.compare(password, admin ? admin.password : DUMMY_HASH);
    if (!admin || !matches) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    const token = jwt.sign({ id: admin.id, email: admin.email }, config.jwtSecret, { expiresIn: "8h" });
    return res.json({
      success: true,
      message: "Login successful",
      token,
      admin: { id: admin.id, email: admin.email },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

module.exports = router;

import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { userRepository, writeAudit } from "@/lib/repositories";
import { roleSchema, type User } from "@/lib/types";

const createAccountSchema = z.object({
  username: z.string().trim().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  email: z.string().trim().email("Enter a valid email"),
  role: roleSchema,
  active: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 });

    const raw = await request.json();
    const input = createAccountSchema.parse(raw);

    const users = await userRepository.list();
    const username = input.username.toLowerCase();
    const email = input.email.toLowerCase();
    if (users.some((user) => user.username.toLowerCase() === username)) throw new Error("Username already exists");
    if (users.some((user) => user.email && user.email.toLowerCase() === email)) throw new Error("Email already exists");

    const passwordHash = await bcrypt.hash(input.password, 10);
    const user: User = {
      id: crypto.randomUUID(),
      username: input.username,
      name: input.username,
      email: input.email,
      passwordHash,
      role: input.role,
      active: input.active,
    };
    await userRepository.create(user);
    const created: Omit<User, "passwordHash"> = {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
    };

    await writeAudit({
      action: "create",
      entity: "user",
      entityId: created.id,
      actor: session.username,
      details: { username: created.username, email: created.email, role: created.role, active: created.active },
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message || "Invalid account data"
      : error instanceof Error ? error.message : "Could not create account";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

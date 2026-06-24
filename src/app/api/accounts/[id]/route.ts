import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { updateJson } from "@/lib/json-store";
import { writeAudit } from "@/lib/repositories";
import { roleSchema, userListSchema, type User } from "@/lib/types";

const updateAccountSchema = z.object({
  username: z.string().trim().min(3, "Username must be at least 3 characters"),
  password: z.string().optional(),
  email: z.string().trim().email("Enter a valid email"),
  role: roleSchema,
  active: z.boolean(),
});

function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
  };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 });

    const { id } = await params;
    const input = updateAccountSchema.parse(await request.json());
    if (input.password && input.password.length < 6) throw new Error("Password must be at least 6 characters");
    if (id === session.userId && (input.role !== "admin" || !input.active)) {
      throw new Error("You cannot remove your own admin access");
    }
    const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;

    let previous: User | undefined;
    let updated: User | undefined;
    await updateJson("auth/users.json", userListSchema, (users) => {
      const username = input.username.toLowerCase();
      const email = input.email.toLowerCase();
      if (users.some((user) => user.id !== id && user.username.toLowerCase() === username)) throw new Error("Username already exists");
      if (users.some((user) => user.id !== id && user.email && user.email.toLowerCase() === email)) throw new Error("Email already exists");
      return users.map((user) => {
        if (user.id !== id) return user;
        previous = user;
        updated = {
          ...user,
          username: input.username,
          name: input.username,
          email: input.email,
          role: input.role,
          active: input.active,
          passwordHash: passwordHash || user.passwordHash,
        };
        return updated;
      });
    });

    if (!previous || !updated) throw new Error("Account not found");
    await writeAudit({
      action: "update",
      entity: "user",
      entityId: updated.id,
      actor: session.username,
      details: {
        previousUsername: previous.username,
        username: updated.username,
        previousEmail: previous.email,
        email: updated.email,
        previousRole: previous.role,
        role: updated.role,
        previousActive: previous.active,
        active: updated.active,
        passwordChanged: Boolean(passwordHash),
      },
    });

    return NextResponse.json(publicUser(updated));
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message || "Invalid account update"
      : error instanceof Error ? error.message : "Could not update account";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

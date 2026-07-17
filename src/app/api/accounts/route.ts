import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { userRepository, writeAudit } from "@/lib/repositories";
import type { User } from "@/lib/types";
import { accountCreateSchema } from "@/lib/mutation-schemas";
import { HttpError, readJsonBody, safeErrorResponse } from "@/lib/request-security";
import { toAdminUserDto } from "@/lib/user-dto";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 });

    const input = await readJsonBody(request, accountCreateSchema);

    const users = await userRepository.list();
    const username = input.username.toLowerCase();
    const email = input.email.toLowerCase();
    if (users.some((user) => user.username.toLowerCase() === username)) throw new HttpError(409, "USERNAME_EXISTS", "Username already exists");
    if (users.some((user) => user.email && user.email.toLowerCase() === email)) throw new HttpError(409, "EMAIL_EXISTS", "Email already exists");

    const passwordHash = await bcrypt.hash(input.password, 10);
    const user: User = {
      id: crypto.randomUUID(),
      username: input.username,
      name: input.username,
      email: input.email,
      passwordHash,
      role: input.role,
      active: input.active,
      authVersion: 1,
    };
    await userRepository.create(user);
    const created = toAdminUserDto(user);

    await writeAudit({
      action: "create",
      entity: "user",
      entityId: created.id,
      actor: session.username,
      details: { username: created.username, email: created.email, role: created.role, active: created.active },
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return safeErrorResponse(error, "Could not create account", request, 400);
  }
}

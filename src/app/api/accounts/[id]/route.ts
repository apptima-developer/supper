import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { userRepository, writeAudit } from "@/lib/repositories";
import { accountUpdateSchema } from "@/lib/mutation-schemas";
import { HttpError, readJsonBody, safeErrorResponse } from "@/lib/request-security";
import { toAdminUserDto } from "@/lib/user-dto";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 });

    const { id } = await params;
    const input = await readJsonBody(request, accountUpdateSchema);
    if (id === session.userId && (input.role !== "admin" || !input.active)) {
      throw new HttpError(400, "SELF_ADMIN_LOCKOUT", "You cannot remove your own admin access");
    }
    const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;

    const users = await userRepository.list();
    const username = input.username.toLowerCase();
    const email = input.email.toLowerCase();
    if (users.some((user) => user.id !== id && user.username.toLowerCase() === username)) throw new HttpError(409, "USERNAME_EXISTS", "Username already exists");
    if (users.some((user) => user.id !== id && user.email && user.email.toLowerCase() === email)) throw new HttpError(409, "EMAIL_EXISTS", "Email already exists");

    const previous = users.find((user) => user.id === id);
    if (!previous) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    const securityChanged = Boolean(passwordHash)
      || previous.username !== input.username
      || previous.email !== input.email
      || previous.role !== input.role
      || previous.active !== input.active;
    const updated = previous ? {
      ...previous,
      username: input.username,
      name: input.username,
      email: input.email,
      role: input.role,
      active: input.active,
      passwordHash: passwordHash || previous.passwordHash,
      authVersion: securityChanged ? previous.authVersion + 1 : previous.authVersion,
    } : undefined;
    if (updated) await userRepository.save(updated);

    if (!updated) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "Account not found");
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

    return NextResponse.json(toAdminUserDto(updated));
  } catch (error) {
    return safeErrorResponse(error, "Could not update account", request, 400);
  }
}

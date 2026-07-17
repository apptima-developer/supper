import type { User } from "./types";

export type AdminUserDto = Pick<User, "id" | "username" | "name" | "email" | "role" | "active">;

export function toAdminUserDto(user: User): AdminUserDto {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
  };
}

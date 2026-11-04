export function companyUserLabel(user: { username: string; displayName?: string }): string {
  const name = user.displayName?.trim();
  return name && name.toLowerCase() !== user.username.toLowerCase()
    ? `${name}（${user.username}）` : user.username;
}

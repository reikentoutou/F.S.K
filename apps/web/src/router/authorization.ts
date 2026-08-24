import type { AppRole, AuthUser } from '@/stores/auth';

export interface AuthorizationTarget {
  path: string;
  isPublic: boolean;
  requiredRole?: AppRole;
}

export type AuthorizationResult =
  | true
  | { name: 'login'; query: { redirect: string } }
  | { name: 'owner-home' | 'kitchen-home' };

function roleHome(role: AppRole): { name: 'owner-home' | 'kitchen-home' } {
  return { name: role === 'OWNER' ? 'owner-home' : 'kitchen-home' };
}

function isKitchenCreateRoute(path: string): boolean {
  return path === '/kitchen' || path.startsWith('/kitchen/report/');
}

export function authorizeNavigation(
  target: AuthorizationTarget,
  user: AuthUser | null,
): AuthorizationResult {
  if (target.isPublic) return true;
  if (!user) {
    return { name: 'login', query: { redirect: target.path } };
  }

  if (user.role === 'KITCHEN') {
    if (target.requiredRole === 'KITCHEN' && isKitchenCreateRoute(target.path)) {
      return true;
    }
    return roleHome(user.role);
  }

  if (target.requiredRole === 'OWNER' && target.path.startsWith('/owner')) {
    return true;
  }
  return roleHome(user.role);
}

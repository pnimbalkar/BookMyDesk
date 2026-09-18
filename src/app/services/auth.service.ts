import { isPlatformBrowser } from '@angular/common';
import { computed, inject, Injectable, PLATFORM_ID, signal } from '@angular/core';

interface StoredAuthSession {
  token: string;
  userId: number;
  userName: string;
  expiresAt: number;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private static readonly sessionStorageKey = 'bookmydesk.auth.session';
  private static readonly sessionDurationMs = 5 * 60 * 1000;
  private readonly platformId = inject(PLATFORM_ID);
  private readonly authCodeSignal = signal<string | null>(null);
  private readonly userNameSignal = signal<string | null>(null);
  private readonly tokenSignal = signal<string | null>(null);
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  readonly authCode = this.authCodeSignal.asReadonly();
  readonly userName = this.userNameSignal.asReadonly();
  readonly token = this.tokenSignal.asReadonly();
  readonly authUserId = computed(() => this.extractUserId(this.authCodeSignal()));
  readonly isLoggedIn = computed(() => this.authCodeSignal() !== null);

  constructor() {
    this.restoreSession();
  }

  setAuthSession(token: string, userId: number, userName: string): void {
    const expiresAt = Date.now() + AuthService.sessionDurationMs;
    this.tokenSignal.set(token);
    this.authCodeSignal.set(`book@${userId}`);
    this.userNameSignal.set(userName);
    this.saveSession({ token, userId, userName, expiresAt });
    this.scheduleExpiry(expiresAt);
  }

  logout(): void {
    this.clearExpiryTimer();
    this.tokenSignal.set(null);
    this.authCodeSignal.set(null);
    this.userNameSignal.set(null);
    if (isPlatformBrowser(this.platformId)) {
      sessionStorage.removeItem(AuthService.sessionStorageKey);
    }
  }

  private restoreSession(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    const storedSession = sessionStorage.getItem(AuthService.sessionStorageKey);
    if (!storedSession) {
      return;
    }

    const session = this.parseStoredSession(storedSession);
    if (!session || session.expiresAt <= Date.now()) {
      this.logout();
      return;
    }

    this.tokenSignal.set(session.token);
    this.authCodeSignal.set(`book@${session.userId}`);
    this.userNameSignal.set(session.userName);
    this.scheduleExpiry(session.expiresAt);
  }

  private saveSession(session: StoredAuthSession): void {
    if (isPlatformBrowser(this.platformId)) {
      sessionStorage.setItem(AuthService.sessionStorageKey, JSON.stringify(session));
    }
  }

  private parseStoredSession(value: string): StoredAuthSession | null {
    try {
      const session: unknown = JSON.parse(value);
      if (
        typeof session !== 'object' ||
        session === null ||
        typeof (session as Record<string, unknown>)['token'] !== 'string' ||
        typeof (session as Record<string, unknown>)['userId'] !== 'number' ||
        typeof (session as Record<string, unknown>)['userName'] !== 'string' ||
        typeof (session as Record<string, unknown>)['expiresAt'] !== 'number'
      ) {
        return null;
      }
      return session as StoredAuthSession;
    } catch {
      return null;
    }
  }

  private scheduleExpiry(expiresAt: number): void {
    this.clearExpiryTimer();
    this.expiryTimer = setTimeout(() => this.logout(), Math.max(0, expiresAt - Date.now()));
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private extractUserId(code: string | null): number | null {
    if (!code) {
      return null;
    }

    const match = /^book@(\d{1,2})$/i.exec(code.trim());
    if (!match) {
      return null;
    }

    const userId = Number(match[1]);
    if (!Number.isFinite(userId) || userId < 1) {
      return null;
    }

    return userId;
  }
}

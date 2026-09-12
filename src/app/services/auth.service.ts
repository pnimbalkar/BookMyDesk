import { computed, inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly storageKey = 'bookmydesk-auth-code';
  private readonly userNameStorageKey = 'bookmydesk-user-name';

  private readonly authCodeSignal = signal<string | null>(this.readStoredCode());
  private readonly userNameSignal = signal<string | null>(this.readStoredUserName());

  readonly authCode = this.authCodeSignal.asReadonly();
  readonly userName = this.userNameSignal.asReadonly();
  readonly authUserId = computed(() => this.extractUserId(this.authCodeSignal()));
  readonly isLoggedIn = computed(() => this.authCodeSignal() !== null);

  setAuthCode(code: string, userName: string): void {
    this.authCodeSignal.set(code);
    this.userNameSignal.set(userName);

    if (isPlatformBrowser(this.platformId)) {
      try {
        localStorage.setItem(this.storageKey, code);
        localStorage.setItem(this.userNameStorageKey, userName);
      } catch {
        // Keep in-memory auth when browser storage is unavailable.
      }
    }
  }

  logout(): void {
    this.authCodeSignal.set(null);
    this.userNameSignal.set(null);

    if (isPlatformBrowser(this.platformId)) {
      try {
        localStorage.removeItem(this.storageKey);
        localStorage.removeItem(this.userNameStorageKey);
      } catch {
        // Ignore storage errors during logout.
      }
    }
  }

  private readStoredCode(): string | null {
    if (!isPlatformBrowser(this.platformId)) {
      return null;
    }

    try {
      return localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  private readStoredUserName(): string | null {
    if (!isPlatformBrowser(this.platformId)) {
      return null;
    }

    try {
      return localStorage.getItem(this.userNameStorageKey);
    } catch {
      return null;
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

import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';
import { DeskBookingService } from '../services/desk-booking.service';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class Login {
  private readonly formBuilder = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly bookingService = inject(DeskBookingService);
  private readonly platformId = inject(PLATFORM_ID);

  readonly isLoading = signal(true);
  readonly errorMessage = signal('');
  readonly formSubmitted = signal(false);

  readonly loginForm = this.formBuilder.nonNullable.group({
    userId: [0, [Validators.required, Validators.min(1)]],
    passcode: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]]
  });
  readonly users = this.bookingService.getUsers();

  readonly showValidationError = computed(() => {
    return this.formSubmitted() && (
      this.loginForm.controls.userId.invalid || this.loginForm.controls.passcode.invalid
    );
  });

  constructor() {
    void this.initialize();
  }

  async submit(): Promise<void> {
    this.formSubmitted.set(true);
    this.errorMessage.set('');

    if (this.loginForm.invalid) {
      return;
    }

    await this.bookingService.ensureDbLoaded();

    const userId = this.loginForm.controls.userId.value;
    const passcode = this.loginForm.controls.passcode.value.trim();
    const isSuccess = this.bookingService.loginWithPasscode(userId, passcode);

    if (!isSuccess) {
      this.errorMessage.set('Usercode and passcode do not match. Please try again.');
      return;
    }

    const targetUrl = '/dashboard';
    const didNavigate = await this.tryNavigateByUrl(targetUrl);

    if (this.isStillOnLoginPage() && isPlatformBrowser(this.platformId)) {
      window.location.assign(targetUrl);
      return;
    }

    if (!didNavigate) {
      await this.router.navigate(['/dashboard']);
    }
  }

  async continueReadOnly(): Promise<void> {
    await this.router.navigateByUrl('/dashboard');
  }

  private async initialize(): Promise<void> {
    await this.bookingService.ensureDbLoaded();
    this.isLoading.set(false);
  }

  private async tryNavigateByUrl(url: string): Promise<boolean> {
    try {
      return await this.router.navigateByUrl(url);
    } catch {
      return false;
    }
  }

  private isStillOnLoginPage(): boolean {
    if (!isPlatformBrowser(this.platformId)) {
      return false;
    }

    return window.location.pathname === '/login';
  }
}

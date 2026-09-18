import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
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
    passcode: [],
    otherName: ['']
  });
  readonly users = this.bookingService.users;
  private readonly selectedUserId = toSignal(this.loginForm.controls.userId.valueChanges, {
    initialValue: this.loginForm.controls.userId.value
  });
  readonly isOtherSelected = computed(() =>
    this.users().some((user) => user.userId === this.selectedUserId() && user.name === 'Other')
  );

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

    const selectedUser = this.users().find(
      (user) => user.userId === this.loginForm.controls.userId.value
    );
    if (!selectedUser || (!this.isOtherSelected() && this.loginForm.controls.passcode.invalid)) {
      return;
    }

    await this.bookingService.ensureDbLoaded();

    try {
      if (!selectedUser) {
        this.errorMessage.set('Select a user and enter a passcode.');
        return;
      }

      if (!this.isOtherSelected() && this.loginForm.controls.passcode.value <= 0) {
        this.errorMessage.set('Enter a numeric passcode.');
        return;
      }

      const otherName = this.loginForm.controls.otherName.value.trim();
      if (selectedUser.name === 'Other' && !otherName) {
        this.errorMessage.set('Enter the name for the Other user.');
        return;
      }

      await this.bookingService.login({
        name: selectedUser.name,
        passcode: selectedUser.name === 'Other' ? 0 : this.loginForm.controls.passcode.value,
        bookingForName: selectedUser.name === 'Other' ? otherName : null
      }, selectedUser.name === 'Other' ? otherName : null);
    } catch {
      this.errorMessage.set('User name and passcode do not match. Please try again.');
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

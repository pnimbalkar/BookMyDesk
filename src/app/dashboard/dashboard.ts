import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  inject,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';
import { AuthService } from '../services/auth.service';
import { BookingDay, DeskBookingService } from '../services/desk-booking.service';
import { DeskView } from '../models/desk.models';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss'
})
export class Dashboard {
  private readonly actionMessageDurationMs = 5000;
  private readonly actionMessageStorageKey = 'dashboard-action-message';
  private readonly bookingService = inject(DeskBookingService);
  private readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private actionMessageTimerId: number | null = null;
  private actionMessageVersion = 0;

  readonly now = signal(new Date());
  readonly bookingDay = signal<BookingDay>(new Date().getHours() >= 20 ? 'tomorrow' : 'today');
  readonly isLoading = signal(true);
  readonly actionMessage = signal('');

  readonly isReadOnly = computed(() => !this.authService.isLoggedIn());
  readonly isLoggedIn = this.authService.isLoggedIn;
  readonly authCode = this.authService.authCode;
  readonly userName = this.authService.userName;
  private readonly paramMap = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap
  });
  private readonly queryParamMap = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap
  });
  readonly selectedDeskNo = computed(() => {
    const queryDeskNo = this.queryParamMap().get('deskno');
    if (queryDeskNo !== null) {
      return this.extractDeskNumber(queryDeskNo);
    }

    const routeDeskNo = this.paramMap().get('deskNo');
    return this.extractDeskNumber(routeDeskNo);
  });
  readonly hasDeskFilter = computed(() => this.selectedDeskNo() !== null);
  readonly bookingDateLabel = computed(() => this.bookingService.getBookingDateLabel(this.now(), this.bookingDay()));
  readonly todayLabel = computed(() => this.bookingService.getBookingDateLabel(this.now(), 'today'));
  readonly tomorrowLabel = computed(() => this.bookingService.getBookingDateLabel(this.now(), 'tomorrow'));
  readonly deskViews = computed(() => {
    const allDesks = this.bookingService.getDeskViews(this.now(), this.bookingDay());
    const selectedDeskNo = this.selectedDeskNo();

    if (selectedDeskNo === null) {
      return allDesks;
    }

    const selectedDesk = allDesks[selectedDeskNo - 1];
    return selectedDesk ? [selectedDesk] : [];
  });
  readonly selectedDeskFound = computed(() => {
    if (!this.hasDeskFilter()) {
      return true;
    }

    return this.deskViews().length === 1;
  });
  readonly deskBlocks = computed(() => {
    const groupedBlocks = new Map<string, DeskView[]>();

    for (const desk of this.deskViews()) {
      if (this.isReadOnly() && desk.block !== 'Work Station') {
        continue;
      }

      const blockDesks = groupedBlocks.get(desk.block) ?? [];
      groupedBlocks.set(desk.block, [...blockDesks, desk]);
    }

    return Array.from(groupedBlocks.entries()).map(([name, desks]) => ({
      name,
      desks
    }));
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.clearActionMessageTimer();
    });

    this.restoreActionMessage();
    this.startClock();
    void this.initialize();
  }

  async onDeskSelect(desk: DeskView): Promise<void> {
    this.now.set(new Date());

    if (this.isReadOnly()) {
      await this.goToLogin();
      return;
    }

    if (desk.status === 'available') {
      const result = await this.bookingService.bookDesk(desk.id, this.now(), this.bookingDay());
      this.showActionMessage(result.message);
      return;
    }

    if (desk.booking && desk.canCancel) {
      const result = await this.bookingService.cancelDesk(desk.id, desk.booking.reservedFor, this.now());
      this.showActionMessage(result.message);
      return;
    }

    if (desk.booking && !desk.canCancel) {
      this.showActionMessage('Only the user who booked this seat can cancel it.');
      return;
    }

    this.showActionMessage('This seat is already booked.');
  }

  async logout(): Promise<void> {
    this.authService.logout();
    this.showActionMessage('Logged out. Dashboard is now read-only.');
    await this.router.navigateByUrl('/dashboard');
  }

  async goToLogin(): Promise<void> {
    await this.router.navigate(['/login']);
  }

  deskAriaLabel(desk: DeskView): string {
    if (this.isReadOnly()) {
      return `${desk.label}, ${desk.status}. Login required for booking.`;
    }

    if (desk.status === 'available' && desk.canBook) {
      return `${desk.label} is available. Click to book.`;
    }

    if (desk.canCancel) {
      return `${desk.label} is booked by you. Click to cancel.`;
    }

    return `${desk.label} is already booked.`;
  }

  deskActionLabel(desk: DeskView): string {
    if (this.isReadOnly()) {
      return 'Login to access';
    }

    if (desk.status === 'available' && desk.canBook) {
      return 'Click to book';
    }

    if (desk.canCancel) {
      return 'Click to cancel';
    }

    return 'Unavailable';
  }

  canSelectDesk(desk: DeskView): boolean {
    if (this.isReadOnly()) {
      return true;
    }

    if (desk.status === 'available') {
      return desk.canBook;
    }

    return desk.canCancel;
  }

  selectBookingDay(day: string): void {
    if (day === 'today' || day === 'tomorrow') {
      if (day === 'today' && this.now().getHours() >= 20) {
        this.bookingDay.set('tomorrow');
        return;
      }

      this.bookingDay.set(day);
    }
  }

  private async initialize(): Promise<void> {
    await this.bookingService.ensureDbLoaded();
    this.now.set(new Date());
    this.isLoading.set(false);
  }

  private startClock(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    const timerId = window.setInterval(() => {
      this.now.set(new Date());
    }, 600000);

    this.destroyRef.onDestroy(() => {
      window.clearInterval(timerId);
    });
  }

  private showActionMessage(message: string, clearAfterMs: number | null = this.actionMessageDurationMs): void {
    this.actionMessageVersion += 1;
    const currentMessageVersion = this.actionMessageVersion;
    this.clearActionMessageTimer();
    this.actionMessage.set(message);

    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    if (!message) {
      window.sessionStorage.removeItem(this.actionMessageStorageKey);
      return;
    }

    if (clearAfterMs === null || clearAfterMs <= 0 || !message) {
      window.sessionStorage.removeItem(this.actionMessageStorageKey);
      return;
    }

    const expiresAt = Date.now() + clearAfterMs;
    window.sessionStorage.setItem(
      this.actionMessageStorageKey,
      JSON.stringify({ message, expiresAt })
    );

    this.actionMessageTimerId = window.setTimeout(() => {
      if (this.actionMessageVersion !== currentMessageVersion) {
        return;
      }

      this.actionMessage.set('');
      window.sessionStorage.removeItem(this.actionMessageStorageKey);
      this.actionMessageTimerId = null;
    }, clearAfterMs);
  }

  private clearActionMessageTimer(): void {
    if (this.actionMessageTimerId === null || !isPlatformBrowser(this.platformId)) {
      return;
    }

    window.clearTimeout(this.actionMessageTimerId);
    this.actionMessageTimerId = null;
  }

  private restoreActionMessage(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    const rawValue = window.sessionStorage.getItem(this.actionMessageStorageKey);
    if (!rawValue) {
      return;
    }

    try {
      const parsedValue: unknown = JSON.parse(rawValue);
      if (typeof parsedValue !== 'object' || parsedValue === null) {
        window.sessionStorage.removeItem(this.actionMessageStorageKey);
        return;
      }

      const message =
        'message' in parsedValue && typeof parsedValue.message === 'string' ? parsedValue.message : '';
      const expiresAt =
        'expiresAt' in parsedValue && typeof parsedValue.expiresAt === 'number' ? parsedValue.expiresAt : 0;
      const remainingMs = expiresAt - Date.now();

      if (!message || remainingMs <= 0) {
        window.sessionStorage.removeItem(this.actionMessageStorageKey);
        return;
      }

      this.actionMessageVersion += 1;
      const currentMessageVersion = this.actionMessageVersion;
      this.actionMessage.set(message);
      this.actionMessageTimerId = window.setTimeout(() => {
        if (this.actionMessageVersion !== currentMessageVersion) {
          return;
        }

        this.actionMessage.set('');
        window.sessionStorage.removeItem(this.actionMessageStorageKey);
        this.actionMessageTimerId = null;
      }, remainingMs);
    } catch (error) {
      console.error('Failed to restore dashboard action message from sessionStorage.', error);
      window.sessionStorage.removeItem(this.actionMessageStorageKey);
    }
  }

  private extractDeskNumber(value: string | null): number | null {
    if (value === null || value.trim().length === 0) {
      return null;
    }

    const cleanedValue = value.startsWith('deskno=') ? value.slice(7) : value;
    const parsedValue = Number.parseInt(cleanedValue, 10);

    if (!Number.isFinite(parsedValue) || parsedValue < 1) {
      return null;
    }

    return parsedValue;
  }
}

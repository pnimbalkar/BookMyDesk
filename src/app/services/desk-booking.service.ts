import { inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { isPlatformBrowser } from '@angular/common';
import { AuthService } from './auth.service';
import { DeskBooking, DeskBookingEvent, DeskDb, DeskUser, DeskView } from '../models/desk.models';
import dbJson from '../../../public/db.json';

export type BookingDay = 'today' | 'tomorrow';

@Injectable({ providedIn: 'root' })

export class DeskBookingService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly apiBaseUrl = this.getApiBaseUrl();
  private readonly bookingApiPath = this.apiUrl('/api/bookings');
  private readonly bookingCleanupApiPath = this.apiUrl('/api/bookings/cleanup');
  private readonly localBookingsStorageKey = 'bookmydesk-bookings';
  private readonly localBookingEventsStorageKey = 'bookmydesk-booking-events';
  private readonly dbSignal = signal<DeskDb>({
    users: dbJson.users,
    desks: dbJson.desks
  });
  private readonly bookingsSignal = signal<DeskBooking[]>([]);
  private readonly bookingEventsSignal = signal<DeskBookingEvent[]>([]);
  private readonly loadedSignal = signal(false);

  private loadPromise: Promise<void> | null = null;

  readonly dbLoaded = this.loadedSignal.asReadonly();

  private getApiBaseUrl(): string {
    if (!isPlatformBrowser(this.platformId)) {
      return '';
    }

    return window.location.hostname.endsWith('github.io')
      ? 'https://bookmydesk.onrender.com'
      : '';
  }

  private apiUrl(path: string): string {
    return `${this.apiBaseUrl}${path}`;
  }

  constructor() {
    this.purgeExpiredBookings(new Date());
  }

  async ensureDbLoaded(): Promise<void> {
    if (this.loadedSignal()) {
      return;
    }

    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this.loadDbInternal();
    return this.loadPromise;
  }

  getUsers(): DeskUser[] {
    return this.dbSignal().users;
  }

  loginWithPasscode(userId: number, code: string): boolean {
    const normalizedCode = code.trim().toLowerCase();
    const selectedUser = this.dbSignal().users.find((user) => user.id === userId);

    const hasMatchingPasscode = selectedUser?.passcode === normalizedCode;

    if (!hasMatchingPasscode || !selectedUser) {
      return false;
    }

    this.authService.setAuthCode(`book@${userId}`, selectedUser.name);
    return true;
  }

  getBookingDateLabel(now: Date, bookingDay: BookingDay): string {
    const bookableDate = this.getBookingDate(now, bookingDay);

    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(bookableDate);
  }

  getDeskViews(now: Date, bookingDay: BookingDay): DeskView[] {
    this.purgeExpiredBookings(now);

    const targetDateKey = this.toDateKey(this.getBookingDate(now, bookingDay));
    const currentCode = this.authService.authCode();

    return this.dbSignal().desks.map((desk) => {
      const storedBooking = this.bookingsSignal().find(
        (entry) => entry.deskId === desk.id && entry.reservedFor === targetDateKey
      ) ?? null;
      const booking = storedBooking
        ? {
            ...storedBooking,
            bookedByName: storedBooking.bookedByName ?? this.getUserNameFromCode(storedBooking.bookedBy)
          }
        : null;

      const canCancel =
        booking !== null &&
        currentCode !== null &&
        booking.bookedBy === currentCode &&
        this.canCancelBooking(booking, now);

      const canBook =
        booking === null &&
        currentCode !== null;

      return {
        ...desk,
        status: booking === null ? 'available' : 'booked',
        booking,
        canBook,
        canCancel
      };
    });
  }

  async bookDesk(deskId: string, now: Date, bookingDay: BookingDay): Promise<{ ok: boolean; message: string }> {
  this.purgeExpiredBookings(now);

  if (bookingDay === 'today' && now.getHours() >= 20) {
    return { ok: false, message: 'Today bookings are closed after 8:00 PM.' };
  }

  const currentCode = this.authService.authCode();

  if (!currentCode) {
    return { ok: false, message: 'Please login to book a desk.' };
  }

  const targetDesk = this.dbSignal().desks.find((desk) => desk.id === deskId);
  if (!targetDesk) {
    return { ok: false, message: 'Desk not found.' };
  }

  const targetDateKey = this.toDateKey(this.getBookingDate(now, bookingDay));
  const existingBookings = this.bookingsSignal();

  if (existingBookings.some((entry) => entry.deskId === deskId && entry.reservedFor === targetDateKey)) {
    return { ok: false, message: 'This desk is already booked.' };
  }

  if (existingBookings.some((entry) => entry.bookedBy === currentCode && entry.reservedFor === targetDateKey)) {
    return { ok: false, message: 'You already have a booking for this day.' };
  }

  const booking: DeskBooking = {
    deskId,
    reservedFor: targetDateKey,
    bookedBy: currentCode,
    bookedByName: this.authService.userName() ?? undefined,
    bookedAt: now.toISOString()
  };

  const bookingEvent: DeskBookingEvent = {
    ...booking,
    action: 'saved',
    actionAt: now.toISOString()
  };
  const nextEvents = [...this.bookingEventsSignal(), bookingEvent];
  const saved = await this.setBookings([...existingBookings, booking], existingBookings, nextEvents);
  if (!saved) {
    return { ok: false, message: 'Booking could not be saved. Please try again.' };
  }

  return { ok: true, message: 'Seat booked successfully.' };
  }

  async cancelDesk(deskId: string, reservedFor: string, now: Date): Promise<{ ok: boolean; message: string }> {
  this.purgeExpiredBookings(now);

  const currentCode = this.authService.authCode();

  if (!currentCode) {
    return { ok: false, message: 'Please login to cancel booking.' };
  }

  const targetDesk = this.dbSignal().desks.find((desk) => desk.id === deskId);
  if (!targetDesk) {
    return { ok: false, message: 'Desk not found.' };
  }

  const booking = this.bookingsSignal().find(
    (entry) => entry.deskId === deskId && entry.reservedFor === reservedFor
  );

  if (!booking) {
    return { ok: false, message: 'Booking not found.' };
  }

  if (booking.bookedBy !== currentCode) {
    return { ok: false, message: 'You can cancel only your own booking.' };
  }

  if (!this.canCancelBooking(booking, now)) {
    return { ok: false, message: 'Cancel is allowed only till next day 10:00 AM.' };
  }

  const remaining = this.bookingsSignal().filter(
    (entry) => !(entry.deskId === deskId && entry.reservedFor === reservedFor)
  );

  const bookingEvent: DeskBookingEvent = {
    ...booking,
    action: 'canceled',
    actionAt: now.toISOString()
  };
  const nextEvents = [...this.bookingEventsSignal(), bookingEvent];
  const saved = await this.setBookings(remaining, this.bookingsSignal(), nextEvents);
  if (!saved) {
    return { ok: false, message: 'Cancel could not be saved. Please try again.' };
  }

  return { ok: true, message: 'Booking canceled successfully.' };
}

  private async loadDbInternal(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      this.loadedSignal.set(true);
      this.loadPromise = null;
      return;
    }

    try {
      const db = await firstValueFrom(this.http.get<DeskDb>(this.apiUrl('/db.json')));
      this.dbSignal.set(db);
    } catch {
      this.dbSignal.set({
        users: dbJson.users,
        desks: dbJson.desks
      });
    }

    try {
      await firstValueFrom(this.http.post(this.bookingCleanupApiPath, {}));
    } catch {
      // Non-blocking: continue with latest available booking data.
    }

    try {
      const response = await firstValueFrom(this.http.get<{
        bookings: DeskBooking[];
        bookingEvents?: DeskBookingEvent[];
      }>(this.bookingApiPath));
      this.bookingsSignal.set(this.sanitizeBookings(response.bookings));
      this.bookingEventsSignal.set(this.sanitizeBookingEvents(response.bookingEvents));
    } catch {
      this.bookingsSignal.set(this.readLocalBookings());
      this.bookingEventsSignal.set(this.readLocalBookingEvents());
    } finally {
      this.loadedSignal.set(true);
      this.loadPromise = null;
    }
  }

  private canCancelBooking(booking: DeskBooking, now: Date): boolean {
    const reservedDate = this.parseDateKey(booking.reservedFor);
    if (!reservedDate) {
      return false;
    }

    const deadline = new Date(reservedDate);
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(10, 0, 0, 0);

    return now <= deadline;
  }

  private getBookingDate(now: Date, bookingDay: BookingDay): Date {
    const selectedDate = new Date(now);
    selectedDate.setHours(0, 0, 0, 0);

    if (bookingDay === 'tomorrow') {
      selectedDate.setDate(selectedDate.getDate() + 1);
    }

    return selectedDate;
  }

  private purgeExpiredBookings(now: Date): void {
    const bookings = this.bookingsSignal();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const clearTodayAt = new Date(today);
    clearTodayAt.setHours(20, 0, 0, 0);

    const activeBookings = bookings.filter((booking) => {
      const reservedDate = this.parseDateKey(booking.reservedFor);
      if (!reservedDate) {
        return false;
      }

      if (reservedDate < today) {
        return false;
      }

      if (reservedDate.getTime() === today.getTime() && now >= clearTodayAt) {
        return false;
      }

      return true;
    });

    if (activeBookings.length !== bookings.length) {
      void this.setBookings(activeBookings, bookings, this.bookingEventsSignal());
    }
  }

  private toDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  private parseDateKey(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);

    return new Date(year, month, day);
  }

  private sanitizeBookings(value: unknown): DeskBooking[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is DeskBooking => {
      if (typeof item !== 'object' || item === null) {
        return false;
      }

      const candidate = item as Partial<DeskBooking>;
      return (
        typeof candidate.deskId === 'string' &&
        typeof candidate.reservedFor === 'string' &&
        typeof candidate.bookedBy === 'string' &&
        (candidate.bookedByName === undefined || typeof candidate.bookedByName === 'string') &&
        typeof candidate.bookedAt === 'string'
      );
    });
  }

  private getUserNameFromCode(code: string): string | undefined {
    const match = /^book@(\d{1,2})$/i.exec(code.trim());
    if (!match) {
      return undefined;
    }

    return this.dbSignal().users.find((user) => user.id === Number(match[1]))?.name;
  }

  private async setBookings(
    bookings: DeskBooking[],
    rollbackState: DeskBooking[],
    bookingEvents: DeskBookingEvent[] = this.bookingEventsSignal(),
    rollbackEvents: DeskBookingEvent[] = this.bookingEventsSignal()
  ): Promise<boolean> {
    this.bookingsSignal.set(bookings);
    this.bookingEventsSignal.set(bookingEvents);

    if (!isPlatformBrowser(this.platformId)) {
      return true;
    }

    try {
      await firstValueFrom(this.http.put(this.bookingApiPath, { bookings, bookingEvents }));
      this.writeLocalBookings(bookings);
      this.writeLocalBookingEvents(bookingEvents);
      return true;
    } catch {
      try {
        this.writeLocalBookings(bookings);
        this.writeLocalBookingEvents(bookingEvents);
        return true;
      } catch {
        this.bookingsSignal.set(rollbackState);
        this.bookingEventsSignal.set(rollbackEvents);
        return false;
      }
    }
  }

  private readLocalBookings(): DeskBooking[] {
    if (!isPlatformBrowser(this.platformId)) {
      return [];
    }

    try {
      const storedBookings = localStorage.getItem(this.localBookingsStorageKey);
      return storedBookings ? this.sanitizeBookings(JSON.parse(storedBookings) as unknown) : [];
    } catch {
      return [];
    }
  }

  private writeLocalBookings(bookings: DeskBooking[]): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    localStorage.setItem(this.localBookingsStorageKey, JSON.stringify(bookings));
  }

  private sanitizeBookingEvents(value: unknown): DeskBookingEvent[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is DeskBookingEvent => {
      if (!this.isDeskBooking(item)) {
        return false;
      }

      const candidate = item as Partial<DeskBookingEvent>;
      return (
        (candidate.action === 'saved' || candidate.action === 'canceled') &&
        typeof candidate.actionAt === 'string'
      );
    });
  }

  private isDeskBooking(value: unknown): value is DeskBooking {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<DeskBooking>;
    return (
      typeof candidate.deskId === 'string' &&
      typeof candidate.reservedFor === 'string' &&
      typeof candidate.bookedBy === 'string' &&
      (candidate.bookedByName === undefined || typeof candidate.bookedByName === 'string') &&
      typeof candidate.bookedAt === 'string'
    );
  }

  private readLocalBookingEvents(): DeskBookingEvent[] {
    if (!isPlatformBrowser(this.platformId)) {
      return [];
    }

    try {
      const storedEvents = localStorage.getItem(this.localBookingEventsStorageKey);
      return storedEvents ? this.sanitizeBookingEvents(JSON.parse(storedEvents) as unknown) : [];
    } catch {
      return [];
    }
  }

  private writeLocalBookingEvents(events: DeskBookingEvent[]): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    localStorage.setItem(this.localBookingEventsStorageKey, JSON.stringify(events));
  }
}

import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { DeskBooking, DeskDefinition, DeskView } from '../models/desk.models';
import { environment } from '../../environments/environment';

export type BookingDay = 'today' | 'tomorrow';

interface AuthResponse {
  token: string;
  userId: number;
  name: string;
  email: string;
}

interface BookingResponse {
  bookingDetailId: number;
  userId: number;
  userName: string;
  workStationCode: string;
  bookingDate: string;
}

interface Credentials {
  name: string;
  passcode: number;
}

export interface LoginUser {
  userId: number;
  name: string;
  email: string;
}

const DESKS: DeskDefinition[] = [
  'W/S - 169', 'W/S - 170', 'W/S - 238', 'W/S - 239', 'W/S - 240', 'W/S - 241', 'W/S - 242',
  'W/S - 243', 'W/S - 244', 'W/S - 245', 'W/S - 246', 'W/S - 247', 'W/S - 248', 'W/S - 249',
  'W/S - 250', 'W/S - 251', 'W/S - 252', 'W/S - 263', 'W/S - 264', 'W/S - 348', 'W/S - 349'
].map((code, index) => ({
  id: code,
  label: code,
  block: 'Work Station',
  deskId: index + 1
}));

@Injectable({ providedIn: 'root' })
export class DeskBookingService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly apiBaseUrl = environment.apiUrl;
  private readonly bookingsSignal = signal<DeskBooking[]>([]);
  private readonly usersSignal = signal<LoginUser[]>([]);
  private readonly loadedSignal = signal(false);
  private readonly loadErrorSignal = signal<string | null>(null);
  private loadPromise: Promise<void> | null = null;

  readonly dbLoaded = this.loadedSignal.asReadonly();
  readonly loadError = this.loadErrorSignal.asReadonly();
  readonly users = this.usersSignal.asReadonly();

  async ensureDbLoaded(): Promise<void> {
    if (!isPlatformBrowser(this.platformId) || this.loadedSignal()) {
      return;
    }

    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = Promise.all([this.loadUsers(), this.loadBookings()]).then(() => undefined).finally(() => {
      this.loadedSignal.set(true);
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  async refreshBookings(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    await this.loadBookings();
  }

  getDeskViews(now: Date, bookingDay: BookingDay): DeskView[] {
    const targetDate = this.toDateKey(this.getBookingDate(now, bookingDay));
    const currentUserId = this.authService.authUserId();

    return DESKS.map((desk) => {
      const booking = this.bookingsSignal().find(
        (item) => item.deskId === desk.id && item.reservedFor === targetDate
      ) ?? null;

      return {
        ...desk,
        status: booking ? 'booked' : 'available',
        booking,
        canBook: booking === null && currentUserId !== null,
        canCancel: booking?.userId === currentUserId && this.canCancelBooking(booking, now)
      };
    });
  }

  getBookingDateLabel(now: Date, bookingDay: BookingDay): string {
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(this.getBookingDate(now, bookingDay));
  }

  async register(request: { name: string; email: string; password: string }): Promise<AuthResponse> {
    return this.request<AuthResponse>('/Auth/register', 'POST', request);
  }

  async loadUsers(): Promise<void> {
    try {
      const users = await this.request<LoginUser[]>('/Auth/users', 'GET');
      this.usersSignal.set(users);
    } catch (error: unknown) {
      this.usersSignal.set([]);
      this.loadErrorSignal.set(this.getErrorMessage(error, 'Unable to load users.'));
    }
  }

  async login(credentials: Credentials): Promise<AuthResponse> {
    const response = await this.request<AuthResponse>('/Auth/login', 'POST', credentials);
    this.authService.setAuthSession(response.token, response.userId, response.name);
    await this.loadBookings();
    return response;
  }

  async bookDesk(
    deskId: string,
    now: Date,
    bookingDay: BookingDay
  ): Promise<{ ok: boolean; message: string }> {
    const bookingDate = this.toDateKey(this.getBookingDate(now, bookingDay));

    try {
      await this.request<BookingResponse>('/Bookings/book', 'POST', {
        workStationCode: deskId,
        bookingDate
      }, true);
      await this.refreshDate(bookingDate);
      return { ok: true, message: 'Seat booked successfully.' };
    } catch (error: unknown) {
      return { ok: false, message: this.getErrorMessage(error, 'Booking could not be saved.') };
    }
  }

  async cancelDesk(
    deskId: string,
    reservedFor: string,
    _now: Date
  ): Promise<{ ok: boolean; message: string }> {
    try {
      await this.requestText('/Bookings/cancel', 'POST', {
        workStationCode: deskId,
        bookingDate: reservedFor
      }, true);
      await this.refreshDate(reservedFor);
      return { ok: true, message: 'Booking canceled successfully.' };
    } catch (error: unknown) {
      return { ok: false, message: this.getErrorMessage(error, 'Booking could not be canceled.') };
    }
  }

  private async loadBookings(): Promise<void> {
    try {
      const today = this.toDateKey(new Date());
      const tomorrow = this.toDateKey(this.getBookingDate(new Date(), 'tomorrow'));
      const [todayBookings, tomorrowBookings] = await Promise.all([
        this.getBookingsByDate(today),
        this.getBookingsByDate(tomorrow)
      ]);
      this.bookingsSignal.set([...todayBookings, ...tomorrowBookings]);
      this.loadErrorSignal.set(null);
    } catch (error: unknown) {
      this.bookingsSignal.set([]);
      this.loadErrorSignal.set(this.getErrorMessage(error, 'Booking server is unavailable.'));
    }
  }

  private async refreshDate(date: string): Promise<void> {
    const refreshedBookings = await this.getBookingsByDate(date);
    this.bookingsSignal.update((bookings) => [
      ...bookings.filter((booking) => booking.reservedFor !== date),
      ...refreshedBookings
    ]);
  }

  private async getBookingsByDate(date: string): Promise<DeskBooking[]> {
    const response = await this.request<BookingResponse[]>(
      `/Bookings/by-date?date=${encodeURIComponent(date)}`,
      'GET'
    );
    return response.map((booking) => ({
      bookingDetailId: booking.bookingDetailId,
      userId: booking.userId,
      deskId: booking.workStationCode,
      reservedFor: booking.bookingDate,
      bookedBy: `book@${booking.userId}`,
      bookedByName: booking.userName
    }));
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    authenticated = false
  ): Promise<T> {
    let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
    const token = this.authService.token();
    if (authenticated && token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }

    return firstValueFrom(this.http.request<T>(method, `${this.apiBaseUrl}${path}`, {
      body,
      headers
    }));
  }

  private async requestText(
    path: string,
    method: 'POST',
    body: unknown,
    authenticated = false
  ): Promise<string> {
    let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
    const token = this.authService.token();
    if (authenticated && token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }

    return firstValueFrom(this.http.request(method, `${this.apiBaseUrl}${path}`, {
      body,
      headers,
      responseType: 'text'
    }));
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse && typeof error.error === 'string' && error.error.trim()) {
      return error.error;
    }

    if (error instanceof HttpErrorResponse && error.error?.message) {
      return error.error.message;
    }

    return fallback;
  }

  private getBookingDate(now: Date, bookingDay: BookingDay): Date {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    if (bookingDay === 'tomorrow') {
      date.setDate(date.getDate() + 1);
    }
    return date;
  }

  private toDateKey(date: Date): string {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  }

  private canCancelBooking(booking: DeskBooking | null, now: Date): boolean {
    if (!booking) {
      return false;
    }

    const deadline = new Date(`${booking.reservedFor}T10:00:00`);
    deadline.setDate(deadline.getDate() + 1);
    return now <= deadline;
  }
}

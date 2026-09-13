export interface DeskDefinition {
  id: string;
  label: string;
  block: string;
  deskId: number;
}

export interface DeskUser {
  id: number;
  name: string;
  passcode: string;
}

export interface DeskDb {
  users: DeskUser[];
  desks: DeskDefinition[];
  bookings?: DeskBooking[];
  bookingEvents?: DeskBookingEvent[];
}

export interface DeskBooking {
  deskId: string;
  reservedFor: string;
  bookedBy: string;
  bookedByName?: string;
  bookedAt: string;
}

export interface DeskBookingEvent extends DeskBooking {
  action: 'saved' | 'canceled';
  actionAt: string;
}

export interface DeskView extends DeskDefinition {
  status: 'available' | 'booked';
  booking: DeskBooking | null;
  canBook: boolean;
  canCancel: boolean;
}

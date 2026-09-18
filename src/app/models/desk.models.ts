export interface DeskDefinition {
  id: string;
  label: string;
  block: string;
  deskId: number;
}

export interface DeskBooking {
  bookingDetailId: number;
  userId: number;
  deskId: string;
  reservedFor: string;
  bookedBy: string;
  bookedByName?: string;
}

export interface DeskView extends DeskDefinition {
  status: 'available' | 'booked';
  booking: DeskBooking | null;
  canBook: boolean;
  canCancel: boolean;
}

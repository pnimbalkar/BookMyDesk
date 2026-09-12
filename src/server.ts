import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');
const workspaceDbPath = join(process.cwd(), 'public/db.json');
const builtDbPath = join(browserDistFolder, 'db.json');

interface DeskBookingRecord {
  deskId: string;
  reservedFor: string;
  bookedBy: string;
  bookedAt: string;
}

interface DeskDbFile {
  users: unknown[];
  desks: unknown[];
  bookings: DeskBookingRecord[];
}

let bookingWriteQueue = Promise.resolve();

const app = express();
app.use(express.json());
const angularApp = new AngularNodeAppEngine();

function isDeskBookingRecord(value: unknown): value is DeskBookingRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<DeskBookingRecord>;
  return (
    typeof candidate.deskId === 'string' &&
    typeof candidate.reservedFor === 'string' &&
    typeof candidate.bookedBy === 'string' &&
    typeof candidate.bookedAt === 'string'
  );
}

function normalizeDb(value: unknown): DeskDbFile {
  if (typeof value !== 'object' || value === null) {
    return {
      users: [],
      desks: [],
      bookings: [],
    };
  }

  const candidate = value as Partial<DeskDbFile>;

  return {
    users: Array.isArray(candidate.users) ? candidate.users : [],
    desks: Array.isArray(candidate.desks) ? candidate.desks : [],
    bookings: Array.isArray(candidate.bookings)
      ? candidate.bookings.filter(isDeskBookingRecord)
      : [],
  };
}

function parseDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);

  return new Date(year, month, day);
}

function getActiveBookings(bookings: DeskBookingRecord[], now: Date): DeskBookingRecord[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const clearTodayAt = new Date(today);
  clearTodayAt.setHours(20, 0, 0, 0);

  return bookings.filter((booking) => {
    const reservedDate = parseDateKey(booking.reservedFor);
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
}

async function resolveDbPath(): Promise<string> {
  const candidates = [workspaceDbPath, builtDbPath];

  for (const path of candidates) {
    try {
      await fs.access(path);
      return path;
    } catch {
      // Try the next candidate path.
    }
  }

  return workspaceDbPath;
}

async function readDbFile(): Promise<{ path: string; db: DeskDbFile }> {
  const path = await resolveDbPath();

  try {
    const rawValue = await fs.readFile(path, 'utf-8');
    const jsonValue = rawValue.charCodeAt(0) === 0xfeff ? rawValue.slice(1) : rawValue;
    return { path, db: normalizeDb(JSON.parse(jsonValue) as unknown) };
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === 'ENOENT') {
      return {
        path,
        db: {
          users: [],
          desks: [],
          bookings: [],
        },
      };
    }

    throw error;
  }
}

async function writeBookings(bookings: DeskBookingRecord[]): Promise<void> {
  bookingWriteQueue = bookingWriteQueue
    .catch(() => {
      // Keep the queue alive even if a previous write failed.
    })
    .then(async () => {
    const { path, db } = await readDbFile();
    const nextDb: DeskDbFile = {
      ...db,
      bookings,
    };

    await fs.writeFile(path, JSON.stringify(nextDb, null, 2), 'utf-8');
    });

  return bookingWriteQueue;
}

app.get('/api/bookings', async (_req, res) => {
  try {
    const { db } = await readDbFile();
    res.status(200).json({ bookings: db.bookings });
  } catch {
    res.status(500).json({ message: 'Unable to read bookings.' });
  }
});

app.put('/api/bookings', async (req, res) => {
  const payload = req.body as { bookings?: unknown };

  if (!Array.isArray(payload.bookings) || !payload.bookings.every(isDeskBookingRecord)) {
    res.status(400).json({ message: 'Invalid bookings payload.' });
    return;
  }

  const sanitizedBookings = payload.bookings.map((booking) => ({
    deskId: booking.deskId,
    reservedFor: booking.reservedFor,
    bookedBy: booking.bookedBy,
    bookedAt: booking.bookedAt,
  }));

  try {
    await writeBookings(sanitizedBookings);
    res.status(200).json({ message: 'Bookings saved.', count: sanitizedBookings.length });
  } catch {
    res.status(500).json({ message: 'Unable to save bookings.' });
  }
});

app.post('/api/bookings/cleanup', async (req, res) => {
  const payload = req.body as { nowIso?: unknown } | undefined;
  const nowCandidate = typeof payload?.nowIso === 'string' ? new Date(payload.nowIso) : new Date();

  if (Number.isNaN(nowCandidate.getTime())) {
    res.status(400).json({ message: 'Invalid nowIso value.' });
    return;
  }

  try {
    const { db } = await readDbFile();
    const activeBookings = getActiveBookings(db.bookings, nowCandidate);
    const removedCount = db.bookings.length - activeBookings.length;

    if (removedCount > 0) {
      await writeBookings(activeBookings);
    }

    res.status(200).json({
      message: 'Cleanup complete.',
      removedCount,
      remainingCount: activeBookings.length,
    });
  } catch {
    res.status(500).json({ message: 'Unable to clean bookings.' });
  }
});

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);

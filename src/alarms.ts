/**
 * Build the `alarms` array for the Infomaniak PIM event API.
 *
 * IMPORTANT — alarm SHAPE (live-verified against the real API):
 *
 *   POST /1/calendar/pim/event and PUT /1/calendar/pim/event/<id>
 *   accept alarms as
 *
 *     [{ "number": <int>, "unit": "minute"|"hour"|"day", "type": "DISPLAY"|"EMAIL"|"SMS"|"WEBHOOK" }]
 *
 * Constraints:
 *   - `unit` MUST be lowercase (uppercase → HTTP 422).
 *   - `type` MUST be uppercase.
 *   - The server converts `unit` to the stored `minutesBefore`
 *     (1 hour → 60, 1 day → 1440).
 *
 * The shape `{ minutesBefore, action }` seen in GET responses is the
 * STORED representation, not the write representation. Sending it on
 * POST/PUT is rejected with `unexpected_error`. That is the bug this
 * helper fixes.
 *
 * Pure / no I/O so it can be unit-tested without network.
 */
export function buildAlarms(
    fullday: boolean | undefined,
    reminderMinutesBefore: number | undefined,
): Array<{ number: number; unit: "minute" | "hour" | "day"; type: "DISPLAY" }> {
    // Explicit "no reminder" → empty array.
    if (reminderMinutesBefore === 0) {
        return [];
    }

    // Caller asked for a specific value → honour it in minutes.
    if (reminderMinutesBefore !== undefined) {
        return [{ number: reminderMinutesBefore, unit: "minute", type: "DISPLAY" }];
    }

    // No explicit value: default to 10 minutes for timed events,
    // 24 hours (1440 minutes) for all-day events.
    if (fullday) {
        return [{ number: 1440, unit: "minute", type: "DISPLAY" }];
    }

    return [{ number: 10, unit: "minute", type: "DISPLAY" }];
}

export type AlarmWriteShape = { number: number; unit: string; type: string };

/**
 * Convert alarms as returned by GET (the STORED representation
 * `[{ minutesBefore, action }]`) into the WRITE representation the
 * POST/PUT endpoints require (`[{ number, unit, type }]`).
 *
 * The server stores every alarm as minutesBefore, so expressing the
 * preserved alarm in `minute` units round-trips exactly. Alarms already
 * in write shape are passed through unchanged. Entries in neither shape
 * are dropped.
 *
 * Without this conversion, a PUT that echoes the stored alarms back is
 * rejected with validation errors on `alarms.0.number` / `.unit` / `.type`.
 *
 * Pure / no I/O so it can be unit-tested without network.
 */
export function storedAlarmsToWriteShape(stored: any[]): AlarmWriteShape[] {
    if (!Array.isArray(stored)) {
        return [];
    }

    const writeShape: AlarmWriteShape[] = [];
    for (const alarm of stored) {
        if (!alarm || typeof alarm !== "object") {
            continue;
        }
        if (typeof alarm.number === "number" && alarm.unit && alarm.type) {
            writeShape.push({ number: alarm.number, unit: String(alarm.unit).toLowerCase(), type: String(alarm.type).toUpperCase() });
            continue;
        }
        if (typeof alarm.minutesBefore === "number") {
            writeShape.push({
                number: alarm.minutesBefore,
                unit: "minute",
                type: String(alarm.action ?? "DISPLAY").toUpperCase(),
            });
        }
    }
    return writeShape;
}

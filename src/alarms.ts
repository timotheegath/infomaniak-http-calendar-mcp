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

export type AlarmWriteShape = { number: number; unit: string; type: string; uuid: string | null };

/**
 * Convert alarms as returned by GET (the STORED representation
 * `[{ minutesBefore, action, uuid, ... }]`) into the WRITE representation
 * the POST/PUT endpoints require (`[{ number, unit, type }]`).
 *
 * The server stores every alarm as minutesBefore, so expressing the
 * preserved alarm in `minute` units round-trips exactly. Alarms already
 * in write shape are passed through unchanged. Entries in neither shape
 * are dropped.
 *
 * PUT-SPECIFIC (live-verified): when the event being updated ALREADY has
 * alarms, every alarm entry in the PUT body MUST carry a `uuid` key —
 * omitting it makes the API fail with a bare 500 `unexpected_error`
 * (the server looks the alarm up by uuid and crashes on undefined).
 * A `null` or unknown uuid is tolerated: the server keeps a matching
 * uuid or assigns a new one. So each converted entry always includes
 * `uuid` (the stored alarm's uuid when present, else null). POST/create
 * does not need a uuid and buildAlarms() does not add one.
 *
 * Without the shape conversion, a PUT that echoes the stored alarms back
 * is rejected with validation errors on `alarms.0.number` / `.unit` / `.type`.
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
        const uuid = typeof alarm.uuid === "string" ? alarm.uuid : null;
        if (typeof alarm.number === "number" && alarm.unit && alarm.type) {
            writeShape.push({ number: alarm.number, unit: String(alarm.unit).toLowerCase(), type: String(alarm.type).toUpperCase(), uuid });
            continue;
        }
        if (typeof alarm.minutesBefore === "number") {
            writeShape.push({
                number: alarm.minutesBefore,
                unit: "minute",
                type: String(alarm.action ?? "DISPLAY").toUpperCase(),
                uuid,
            });
        }
    }
    return writeShape;
}

/**
 * Build the `alarms` array for a PUT (update) request.
 *
 * - `reminderMinutesBefore` given → replace the event's alarms with a
 *   single fresh alarm (0 → empty array, i.e. clear). The new entry
 *   carries the uuid of the first existing alarm (or null) so the PUT
 *   does not hit the uuid-less 500 described above.
 * - otherwise → preserve the existing alarms via storedAlarmsToWriteShape.
 *
 * Pure / no I/O so it can be unit-tested without network.
 */
export function alarmsForUpdate(
    storedAlarms: any[],
    fullday: boolean | undefined,
    reminderMinutesBefore: number | undefined,
): AlarmWriteShape[] {
    if (reminderMinutesBefore !== undefined) {
        const existingUuid =
            Array.isArray(storedAlarms)
                ? (storedAlarms.find((a) => a && typeof a.uuid === "string")?.uuid ?? null)
                : null;
        return buildAlarms(fullday, reminderMinutesBefore).map((alarm) => ({ ...alarm, uuid: existingUuid }));
    }
    return storedAlarmsToWriteShape(storedAlarms);
}

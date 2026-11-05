import { describe, it } from "node:test";
import assert from "node:assert";
import { alarmsForUpdate, buildAlarms, storedAlarmsToWriteShape } from "../dist/alarms.js";

describe("buildAlarms", () => {
    it("timed event, no reminder override → 10 minutes before", () => {
        assert.deepStrictEqual(buildAlarms(false, undefined), [
            { number: 10, unit: "minute", type: "DISPLAY" },
        ]);
    });

    it("all-day event, no reminder override → 24h (1440 minutes) before", () => {
        assert.deepStrictEqual(buildAlarms(true, undefined), [
            { number: 1440, unit: "minute", type: "DISPLAY" },
        ]);
    });

    it("explicit reminder_minutes_before wins over fullday default", () => {
        // 60 minutes, timed event
        assert.deepStrictEqual(buildAlarms(false, 60), [
            { number: 60, unit: "minute", type: "DISPLAY" },
        ]);
        // 60 minutes, all-day — still uses the explicit value (60), not 1440
        assert.deepStrictEqual(buildAlarms(true, 60), [
            { number: 60, unit: "minute", type: "DISPLAY" },
        ]);
        // arbitrary value
        assert.deepStrictEqual(buildAlarms(false, 5), [
            { number: 5, unit: "minute", type: "DISPLAY" },
        ]);
    });

    it("reminder_minutes_before: 0 → empty array (no reminder)", () => {
        assert.deepStrictEqual(buildAlarms(false, 0), []);
        assert.deepStrictEqual(buildAlarms(true, 0), []);
    });

    it("unit is lowercase 'minute' (uppercase would 422 the live API)", () => {
        const alarms = buildAlarms(false, undefined);
        assert.strictEqual(alarms[0].unit, "minute");
        assert.strictEqual(alarms[0].unit, alarms[0].unit.toLowerCase());
    });

    it("type is uppercase 'DISPLAY'", () => {
        const alarms = buildAlarms(false, undefined);
        assert.strictEqual(alarms[0].type, "DISPLAY");
        assert.strictEqual(alarms[0].type, alarms[0].type.toUpperCase());
    });

    it("shape is { number, unit, type } — not the GET/stored { minutesBefore, action } that the API rejects with unexpected_error", () => {
        const alarms = buildAlarms(false, undefined);
        const keys = Object.keys(alarms[0]).sort();
        assert.deepStrictEqual(keys, ["number", "type", "unit"]);
        assert.strictEqual("minutesBefore" in alarms[0], false);
        assert.strictEqual("action" in alarms[0], false);
    });
});

describe("storedAlarmsToWriteShape", () => {
    it("converts the stored { minutesBefore, action } shape into the write { number, unit, type } shape", () => {
        assert.deepStrictEqual(
            storedAlarmsToWriteShape([{ minutesBefore: 1, action: "DISPLAY" }]),
            [{ number: 1, unit: "minute", type: "DISPLAY", uuid: null }],
        );
        assert.deepStrictEqual(
            storedAlarmsToWriteShape([{ minutesBefore: 1440, action: "EMAIL" }]),
            [{ number: 1440, unit: "minute", type: "EMAIL", uuid: null }],
        );
    });

    it("keeps the stored alarm uuid on the write-shape entry (PUT 500s without a uuid key)", () => {
        assert.deepStrictEqual(
            storedAlarmsToWriteShape([{ minutesBefore: 1, action: "DISPLAY", uuid: "96b684c4-abcd" }]),
            [{ number: 1, unit: "minute", type: "DISPLAY", uuid: "96b684c4-abcd" }],
        );
    });

    it("defaults a missing action to DISPLAY and uppercases it", () => {
        assert.deepStrictEqual(
            storedAlarmsToWriteShape([{ minutesBefore: 10, action: "email" }]),
            [{ number: 10, unit: "minute", type: "EMAIL", uuid: null }],
        );
        assert.deepStrictEqual(
            storedAlarmsToWriteShape([{ minutesBefore: 10 }]),
            [{ number: 10, unit: "minute", type: "DISPLAY", uuid: null }],
        );
    });

    it("passes through alarms already in write shape, normalising case and keeping uuid", () => {
        assert.deepStrictEqual(
            storedAlarmsToWriteShape([{ number: 2, unit: "HOUR", type: "display", uuid: "u-1" }]),
            [{ number: 2, unit: "hour", type: "DISPLAY", uuid: "u-1" }],
        );
    });

    it("handles empty / non-array input and drops malformed entries", () => {
        assert.deepStrictEqual(storedAlarmsToWriteShape([]), []);
        assert.deepStrictEqual(storedAlarmsToWriteShape(undefined), []);
        assert.deepStrictEqual(storedAlarmsToWriteShape(null), []);
        assert.deepStrictEqual(storedAlarmsToWriteShape([null, "x", {}, { minutesBefore: "5" }]), []);
    });

    it("output never contains the stored keys the PUT endpoint rejects", () => {
        const out = storedAlarmsToWriteShape([{ minutesBefore: 5, action: "DISPLAY", uuid: "u" }]);
        for (const alarm of out) {
            assert.deepStrictEqual(Object.keys(alarm).sort(), ["number", "type", "unit", "uuid"]);
        }
    });
});

describe("alarmsForUpdate", () => {
    const STORED = [{ minutesBefore: 1, action: "DISPLAY", uuid: "96b684c4-abcd" }];

    it("preserves existing alarms in write shape WITH their uuid", () => {
        assert.deepStrictEqual(
            alarmsForUpdate(STORED, false, undefined),
            [{ number: 1, unit: "minute", type: "DISPLAY", uuid: "96b684c4-abcd" }],
        );
    });

    it("explicit reminder_minutes_before replaces the alarm and inherits the existing uuid", () => {
        assert.deepStrictEqual(
            alarmsForUpdate(STORED, false, 30),
            [{ number: 30, unit: "minute", type: "DISPLAY", uuid: "96b684c4-abcd" }],
        );
    });

    it("reminder_minutes_before=0 clears alarms (empty array)", () => {
        assert.deepStrictEqual(alarmsForUpdate(STORED, false, 0), []);
    });

    it("replacement alarm on an event WITHOUT alarms still carries a uuid key (null)", () => {
        assert.deepStrictEqual(
            alarmsForUpdate([], false, 15),
            [{ number: 15, unit: "minute", type: "DISPLAY", uuid: null }],
        );
    });

    it("preserve path on an event without alarms sends an empty array", () => {
        assert.deepStrictEqual(alarmsForUpdate([], false, undefined), []);
    });
});

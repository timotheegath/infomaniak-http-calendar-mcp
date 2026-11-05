/**
 * Regression test for the updateEvent alarm payload.
 *
 * Bug: calendar_update_event failed with validation_rule_required on
 * alarms.0.number / .unit / .type for ANY event that has an alarm,
 * because updateEvent echoed the GET response's STORED alarm shape
 * [{minutesBefore, action}] into the PUT body, while the PUT endpoint
 * requires the WRITE shape [{number, unit, type}] (unit lowercase,
 * type uppercase — see ./alarms.ts).
 *
 * These tests capture the PUT body actually handed to fetch() and assert
 * on the alarms array: a partial update (only start/end changed) must
 * preserve the existing alarm in write shape, an explicit
 * reminder_minutes_before must override it, and 0 must clear it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {CalendarClient} from '../dist/calendar-client.js';

const PROFILE = {data: {preferences: {timezone: {name: 'Europe/Paris'}}}};

const STORED_EVENT = {
    id: 42,
    calendar_id: 2107270,
    title: 'Standup',
    description: '',
    start: '2026-11-05 09:00:00',
    end: '2026-11-05 09:15:00',
    timezone_start: 'Europe/Paris',
    timezone_end: 'Europe/Paris',
    freebusy: 'busy',
    type: 'event',
    fullday: false,
    attendees: [],
    // Stored shape as returned by GET /1/calendar/pim/event/<id>
    alarms: [{minutesBefore: 1, action: 'DISPLAY'}],
};

/** Run updateEvent with fetch mocked; returns the parsed PUT body. */
async function updatePayload({event = STORED_EVENT, reminderMinutesBefore} = {}) {
    const originalFetch = globalThis.fetch;
    let payload = null;
    globalThis.fetch = async (url, options = {}) => {
        const u = String(url);
        const method = options.method || 'GET';
        if (u === 'https://api.infomaniak.com/2/profile') {
            return {ok: true, json: async () => PROFILE, text: async () => ''};
        }
        if (u === `https://api.infomaniak.com/1/calendar/pim/event/${event.id}` && method === 'GET') {
            return {ok: true, json: async () => ({result: 'success', data: event}), text: async () => ''};
        }
        if (u === `https://api.infomaniak.com/1/calendar/pim/event/${event.id}` && method === 'PUT') {
            payload = JSON.parse(options.body);
            return {ok: true, json: async () => ({result: 'success', data: payload}), text: async () => ''};
        }
        throw new Error(`unexpected fetch: ${method} ${u}`);
    };
    try {
        const client = new CalendarClient('test-token');
        await client.updateEvent(
            String(event.id), undefined, '2026-11-05 10:00:00', '2026-11-05 10:15:00',
            undefined, undefined, undefined, undefined, undefined, reminderMinutesBefore,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.ok(payload, 'updateEvent never issued the PUT');
    return payload;
}

test('partial update preserves an existing alarm in WRITE shape {number, unit, type}', async () => {
    const body = await updatePayload();
    assert.deepEqual(body.alarms, [{number: 1, unit: 'minute', type: 'DISPLAY'}]);
});

test('preserved alarm never uses the stored shape ({minutesBefore, action})', async () => {
    const body = await updatePayload();
    for (const alarm of body.alarms) {
        assert.ok(!('minutesBefore' in alarm),
            `stored shape leaked into the PUT body: ${JSON.stringify(body.alarms)}`);
        assert.ok(!('action' in alarm),
            `stored shape leaked into the PUT body: ${JSON.stringify(body.alarms)}`);
    }
});

test('event without alarms sends an empty alarms array', async () => {
    const body = await updatePayload({event: {...STORED_EVENT, alarms: []}});
    assert.deepEqual(body.alarms, []);
});

test('explicit reminder_minutes_before overrides the existing alarm', async () => {
    const body = await updatePayload({reminderMinutesBefore: 30});
    assert.deepEqual(body.alarms, [{number: 30, unit: 'minute', type: 'DISPLAY'}]);
});

test('reminder_minutes_before=0 clears the alarm', async () => {
    const body = await updatePayload({reminderMinutesBefore: 0});
    assert.deepEqual(body.alarms, []);
});

test('stored alarm with EMAIL action keeps its type, uppercased', async () => {
    const body = await updatePayload({event: {...STORED_EVENT, alarms: [{minutesBefore: 1440, action: 'email'}]}});
    assert.deepEqual(body.alarms, [{number: 1440, unit: 'minute', type: 'EMAIL'}]);
});

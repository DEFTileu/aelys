# Calendar grid clipping and time guides

Task: IMPLEMENTATION_PLAN Phase 3 / task 1 (Calendar), owner-reported layout
repair, 2026-11-04. Existing visual direction and calendar data are preserved.
No OPEN architecture/integration decisions are resolved by this change.

The schedule viewport had a fixed 624px height and a hidden scrollbar while its
outer card stretched to the sidebar's height. This left a blank area below the
scroll boundary, making partially visible events look permanently cut off.
The calendar card now uses a column flex layout: the schedule fills the card's
remaining height and retains its own visible thin scrollbar and keyboard focus.
Toolbar and day headers keep their intrinsic height. Mobile agenda/month behavior
is preserved.

The calendar had no horizontal time guides. Hour and half-hour guides now share
its actual hour height and top padding through CSS variables. The CSS grid height
also derives from those values, keeping hour labels, events, the current-time
marker and guides on the same scale in day/week views and both themes.

A 50-minute event was ~38px tall but its two text lines and padding needed 42px.
Compact padding/line heights fit both lines inside its actual duration. Events
below 36px use a single row, with a full-title/time native tooltip for truncated
labels. The calendar's time scale and stored start/end times are unchanged.

Validation results are recorded with the delivery, including real browser layout
measurements for a tall sidebar, day/week, light/dark, short/50-minute events,
and keyboard scrolling to the final event of the day. Fixtures contain synthetic
classes and remain outside Git. No server, schema, request or cache changes.

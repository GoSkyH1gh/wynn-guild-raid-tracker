"""Cycle bucketing for reward payout periods.

Cycles are derived from a config, never stored. A cycle is a contiguous set
of payout days:

- cycle 0 is a one-off bootstrap period of ``cycle_0_days`` ending at the
  anchor (it covers any pre-launch data),
- cycle 1 starts at the anchor,
- cycles 1..n use the day-counts in ``schedule``, repeating the last entry
  forever (so ``(7,)`` means weekly, ``(7, 14)`` means one 7-day cycle then
  14-day cycles forever).

Completions belong to the cycle of their (offset-shifted) payout day, which
keeps cycle boundaries consistent with ``day_bucket`` payouts.
"""

import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

CAP_DAY_OFFSET_MINUTES = int(os.getenv("CAP_DAY_OFFSET_MINUTES", "0"))

_UTC = timezone.utc


def day_bucket(ts: datetime) -> date:
    """Bucket a timestamp into a payout day, shifted by the configured offset."""
    return (ts + timedelta(minutes=CAP_DAY_OFFSET_MINUTES)).date()


@dataclass(frozen=True)
class CycleSchedule:
    """Schedule definition cycles are derived from.

    anchor:             UTC date cycle 1 starts (cycle 0 ends the day before).
    cycle_0_days:       length of the bootstrap cycle 0, which ends at the anchor.
    schedule:           day-counts for cycles 1, 2, 3, ...; the last repeats.
    payout_window_days: how long after a cycle ends payouts remain valid.
    """

    anchor: date
    cycle_0_days: int = 10
    schedule: tuple[int, ...] = (7,)
    payout_window_days: int = 7

    def __post_init__(self):
        if self.cycle_0_days < 0:
            raise ValueError("cycle_0_days must be >= 0")
        if not self.schedule or any(d <= 0 for d in self.schedule):
            raise ValueError("schedule must be a non-empty tuple of positive day counts")
        if self.payout_window_days < 0:
            raise ValueError("payout_window_days must be >= 0")


@dataclass(frozen=True)
class Cycle:
    index: int
    start: datetime  # inclusive raw-UTC bound (offset shift already inverted)
    end: datetime    # exclusive raw-UTC bound
    start_date: date
    end_date: date   # exclusive
    payout_deadline: datetime

    @property
    def display_end(self) -> date:
        """Last day a completion can fall into this cycle."""
        return self.end_date - timedelta(days=1)

    def is_current(self, now: datetime) -> bool:
        return self.start <= now < self.end

    def is_over(self, now: datetime) -> bool:
        """True once the payout window has closed (more than N days after end)."""
        return now > self.payout_deadline


def _utc(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=_UTC)


def _make_cycle(index: int, start_date: date, end_date: date, config: CycleSchedule) -> Cycle:
    offset = timedelta(minutes=CAP_DAY_OFFSET_MINUTES)
    start_dt = _utc(start_date) - offset
    end_dt = _utc(end_date) - offset
    return Cycle(
        index=index,
        start=start_dt,
        end=end_dt,
        start_date=start_date,
        end_date=end_date,
        payout_deadline=end_dt + timedelta(days=config.payout_window_days),
    )


def cycle_for_index(index: int, config: CycleSchedule) -> Cycle:
    """Return the cycle with the given index (0 is the bootstrap cycle)."""
    if index < 0:
        raise ValueError("index must be >= 0")
    if index == 0:
        return _make_cycle(
            0,
            config.anchor - timedelta(days=config.cycle_0_days),
            config.anchor,
            config,
        )
    start = config.anchor
    for i in range(1, index + 1):
        duration = config.schedule[min(i - 1, len(config.schedule) - 1)]
        end = start + timedelta(days=duration)
        if i == index:
            return _make_cycle(index, start, end, config)
        start = end
    raise AssertionError("unreachable")


def cycle_for(ts: datetime | date, config: CycleSchedule) -> Cycle:
    """Return the cycle a timestamp (or payout day) falls into."""
    day = day_bucket(ts) if isinstance(ts, datetime) else ts
    if day < config.anchor:
        return cycle_for_index(0, config)
    start = config.anchor
    index = 1
    while True:
        duration = config.schedule[min(index - 1, len(config.schedule) - 1)]
        end = start + timedelta(days=duration)
        if day < end:
            return _make_cycle(index, start, end, config)
        start = end
        index += 1


def list_cycles(config: CycleSchedule, now: datetime | None = None) -> list[Cycle]:
    """All cycles from 0 up to (and including) the one containing ``now``."""
    now = now or datetime.now(_UTC)
    return [cycle_for_index(i, config) for i in range(cycle_for(now, config).index + 1)]


def validate_payout_range(
    starts_at: datetime,
    ends_at: datetime,
    config: CycleSchedule,
    now: datetime | None = None,
) -> Cycle:
    """Validate a payout range: it must fall within a single cycle whose
    payout window is still open. Returns the cycle, or raises ValueError."""
    now = now or datetime.now(_UTC)
    cycle = cycle_for(starts_at, config)
    if ends_at > cycle.end:
        raise ValueError("payout range spans multiple cycles")
    if cycle.is_over(now):
        raise ValueError("payout window for this cycle has closed")
    return cycle

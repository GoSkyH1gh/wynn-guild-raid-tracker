from datetime import date, datetime, timedelta, timezone

import pytest

from backend.cycles import (
    CycleSchedule,
    cycle_for,
    cycle_for_index,
    day_bucket,
    list_cycles,
)

UTC = timezone.utc


def cfg(**kw) -> CycleSchedule:
    defaults = dict(
        anchor=date(2026, 7, 27),
        cycle_0_days=10,
        schedule=(7,),
        payout_window_days=7,
    )
    defaults.update(kw)
    return CycleSchedule(**defaults)


def dt(y, m, d, hh=12, mi=0):
    return datetime(y, m, d, hh, mi, tzinfo=UTC)


def test_cycle_0_ends_at_anchor():
    c = cfg()
    c0 = cycle_for_index(0, c)
    assert c0.index == 0
    assert c0.start_date == date(2026, 7, 17)
    assert c0.end_date == date(2026, 7, 27)
    assert c0.display_end == date(2026, 7, 26)
    assert c0.start == datetime(2026, 7, 17, tzinfo=UTC)
    assert c0.end == datetime(2026, 7, 27, tzinfo=UTC)


def test_weekly_schedule_repeats_last_entry():
    c = cfg()
    c1 = cycle_for_index(1, c)
    c2 = cycle_for_index(2, c)
    c3 = cycle_for_index(3, c)
    assert c1.start_date == date(2026, 7, 27) and c1.end_date == date(2026, 8, 3)
    assert c1.display_end == date(2026, 8, 2)
    assert c2.start_date == date(2026, 8, 3) and c2.end_date == date(2026, 8, 10)
    assert c3.start_date == date(2026, 8, 10) and c3.end_date == date(2026, 8, 17)


def test_schedule_with_longer_cycles_later():
    c = cfg(schedule=(7, 7, 7, 14))
    c3 = cycle_for_index(3, c)
    c4 = cycle_for_index(4, c)
    c5 = cycle_for_index(5, c)
    assert c3.end_date - c3.start_date == timedelta(days=7)
    assert c4.end_date - c4.start_date == timedelta(days=14)
    assert c5.end_date - c5.start_date == timedelta(days=14)


def test_cycle_for_buckets_by_day():
    c = cfg()
    assert cycle_for(dt(2026, 7, 26, 23, 59), c).index == 0
    assert cycle_for(dt(2026, 7, 27, 0, 0), c).index == 1
    assert cycle_for(dt(2026, 8, 2, 23, 59), c).index == 1
    assert cycle_for(dt(2026, 8, 3, 0, 0), c).index == 2
    assert cycle_for(dt(2026, 8, 10, 0, 0), c).index == 3


def test_cycle_for_accepts_date():
    c = cfg()
    assert cycle_for(date(2026, 8, 5), c).index == 2


def test_day_bucket_respects_offset(monkeypatch):
    monkeypatch.setattr("backend.cycles.CAP_DAY_OFFSET_MINUTES", 90)
    assert day_bucket(datetime(2026, 8, 6, 23, 0, tzinfo=UTC)) == date(2026, 8, 7)


def test_offset_shifts_cycle_boundary(monkeypatch):
    monkeypatch.setattr("backend.cycles.CAP_DAY_OFFSET_MINUTES", 120)
    c = cfg()
    c1 = cycle_for_index(1, c)
    c2 = cycle_for_index(2, c)

    # raw bounds must invert the shift: cycle 2 starts at 22:00 UTC on Aug 2
    assert c1.end == datetime(2026, 8, 3, tzinfo=UTC) - timedelta(hours=2)
    assert c2.start == c1.end

    # a completion at 23:30 UTC on Aug 2 shifts into Aug 3 → cycle 2, not cycle 1
    assert cycle_for(dt(2026, 8, 2, 23, 30), c).index == 2
    assert not (c1.start <= dt(2026, 8, 2, 23, 30) < c1.end)
    assert c2.start <= dt(2026, 8, 2, 23, 30) < c2.end


def test_raw_bounds_match_shifted_day_membership(monkeypatch):
    monkeypatch.setattr("backend.cycles.CAP_DAY_OFFSET_MINUTES", 30)
    c = cfg()
    for i in range(0, 4):
        cy = cycle_for_index(i, c)
        mid = cy.start + (cy.end - cy.start) / 2
        assert cycle_for(mid, c).index == i


def test_payout_deadline_and_status():
    c = cfg()
    c1 = cycle_for_index(1, c)
    assert c1.payout_deadline == c1.end + timedelta(days=7)
    assert c1.is_current(dt(2026, 7, 30)) is True
    assert c1.is_current(dt(2026, 8, 4)) is False
    assert c1.is_over(dt(2026, 8, 10, 0, 0)) is False  # exactly the deadline: still valid
    assert c1.is_over(dt(2026, 8, 10, 0, 1)) is True
    assert c1.is_over(dt(2026, 8, 11)) is True


def test_list_cycles_up_to_current():
    c = cfg()
    cycles = list_cycles(c, now=dt(2026, 8, 6))
    assert [cy.index for cy in cycles] == [0, 1, 2]

    cycles_before_anchor = list_cycles(c, now=dt(2026, 7, 20))
    assert [cy.index for cy in cycles_before_anchor] == [0]


def test_config_validation():
    with pytest.raises(ValueError):
        cfg(schedule=())
    with pytest.raises(ValueError):
        cfg(schedule=(0,))
    with pytest.raises(ValueError):
        cfg(cycle_0_days=-1)
    with pytest.raises(ValueError):
        cfg(payout_window_days=-1)


def test_user_test_scenario():
    # anchor = first day of fetches (2026-07-27); cycle 2 starts one week later
    c = cfg(anchor=date(2026, 7, 27), cycle_0_days=10, schedule=(7,))

    # real completions span 2026-07-27 → 2026-08-06: cycles 1 and 2 only
    assert cycle_for(dt(2026, 7, 27, 15, 1), c).index == 1  # first completion
    assert cycle_for(dt(2026, 8, 6, 18, 40), c).index == 2  # latest completion

    # as of Aug 7: cycle 1 has ended (still within payout window), cycle 2 is current
    now = dt(2026, 8, 7, 12)
    c1 = cycle_for_index(1, c)
    assert not c1.is_current(now)
    assert not c1.is_over(now)
    assert cycle_for(now, c).index == 2

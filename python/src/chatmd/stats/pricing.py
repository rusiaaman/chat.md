"""Optional cost estimation.

There is deliberately no built-in price table. Prices change, vary by tier and by
host, and a wrong number presented as a cost is worse than no number at all — so
cost is reported only for models the user has priced themselves, under
``pricing`` in the config file:

```json
"pricing": {
  "claude-opus-5": {"input": 5.0, "output": 25.0, "cacheRead": 0.5, "cacheWrite": 6.25}
}
```

Values are US dollars per million tokens. Keys match a model name by longest
prefix, so ``claude-opus-5`` covers ``claude-opus-5-20260101``.
"""

from __future__ import annotations

from typing import Any

from ..types import Usage

_PER_MILLION = 1_000_000.0

_FIELDS = (
    ("input", "input_tokens"),
    ("output", "output_tokens"),
    ("cacheRead", "cache_read_tokens"),
    ("cacheWrite", "cache_write_tokens"),
)


def find_prices(model: str | None, pricing: dict[str, Any]) -> dict[str, float] | None:
    """The price entry for a model, matched by longest key prefix."""
    if not model or not pricing:
        return None
    best: tuple[int, dict[str, float]] | None = None
    for key, value in pricing.items():
        if not isinstance(value, dict) or not model.startswith(key):
            continue
        if best is None or len(key) > best[0]:
            best = (len(key), value)
    return best[1] if best else None


def estimate_cost(
    model: str | None, usage: Usage | None, pricing: dict[str, Any]
) -> float | None:
    """Cost in USD, or None when the model has no configured price.

    None is a real answer here: it means "not priced", which the dashboard shows
    as a blank rather than as zero.
    """
    if usage is None:
        return None
    prices = find_prices(model, pricing)
    if prices is None:
        return None

    total = 0.0
    for price_key, usage_field in _FIELDS:
        rate = prices.get(price_key)
        tokens = getattr(usage, usage_field)
        if rate is None or tokens is None:
            continue
        try:
            total += (float(tokens) / _PER_MILLION) * float(rate)
        except (TypeError, ValueError):
            continue
    return total

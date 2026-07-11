from __future__ import annotations

from dataclasses import dataclass, field


class ResourceBudgetExceeded(RuntimeError):
    pass


@dataclass(slots=True)
class ResourceBudgetLedger:
    max_model_calls: int = 0
    max_tokens: int = 0
    max_cost_usd: float = 0.0
    model_calls: int = 0
    tokens: int = 0
    cost_usd: float = 0.0
    reservations: dict[str, tuple[int, float]] = field(default_factory=dict)

    def reserve(self, key: str, *, tokens: int = 0, cost_usd: float = 0.0) -> None:
        if key in self.reservations:
            raise ValueError(f"resource reservation already exists: {key}")
        reserved_tokens = sum(value[0] for value in self.reservations.values())
        reserved_cost = sum(value[1] for value in self.reservations.values())
        if self.max_tokens and self.tokens + reserved_tokens + tokens > self.max_tokens:
            raise ResourceBudgetExceeded("token budget reservation exceeded")
        if self.max_cost_usd and self.cost_usd + reserved_cost + cost_usd > self.max_cost_usd:
            raise ResourceBudgetExceeded("cost budget reservation exceeded")
        self.reservations[key] = (max(0, tokens), max(0.0, cost_usd))

    def record_usage(self, key: str, *, tokens: int, cost_usd: float, model_call: bool = True) -> None:
        if model_call and self.max_model_calls and self.model_calls + 1 > self.max_model_calls:
            raise ResourceBudgetExceeded("model call budget exceeded")
        reserved = self.reservations.pop(key, (0, 0.0))
        next_tokens = self.tokens + max(0, tokens)
        next_cost = self.cost_usd + max(0.0, cost_usd)
        if self.max_tokens and next_tokens > self.max_tokens:
            self.reservations[key] = reserved
            raise ResourceBudgetExceeded("token budget exceeded")
        if self.max_cost_usd and next_cost > self.max_cost_usd:
            self.reservations[key] = reserved
            raise ResourceBudgetExceeded("cost budget exceeded")
        self.tokens = next_tokens
        self.cost_usd = next_cost
        if model_call:
            self.model_calls += 1

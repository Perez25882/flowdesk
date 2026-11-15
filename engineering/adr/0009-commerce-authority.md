# 0009 Commerce records and authority

Use independently priced SKU rows in the existing product model, including variants. Parent products group variants. Each tracked SKU provides its own physical quantity and transaction lock. Keep held stock in an itemized quote and count only unexpired, offered quotes against availability. A quote snapshot binds item, unit price, quantity and customer. Acceptance compares current pricing and inventory under lock, commits the existing order and stock movements, and binds the original customer evidence.

Extend the existing G1 ledger rather than creating a money balance in the commerce module. Invoice totals are fixed at issue, and paid and remaining amounts are derived from current verified ledger and settlement records. Provider initialization and reconciliation remain within the G1 service. The workflow engine consumes committed commercial evidence for handoffs.

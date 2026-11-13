# ADR 0005 Typed assistant proposals and verified business effects

**Status** Implemented for G1-05. Founder sign-off is pending.

**Context** The G0 D-05 reproduction showed that AUTONOMOUS could send unsupported figures. A valid citation and a matching number could also describe the wrong product. Drafted text and separate worker fallbacks could reach the customer or produce an order without sharing the router's verdict. See the [source inventory](../g1/ai-trust-boundaries.md).

**Decision** Treat the model as an interpreter. The router validates typed proposals, selects one allowed effect and renders material replies from scoped evidence. Application services repeat tenant, customer, mode and domain checks for mutations. Commit the order and inbound message link together. Use an optional unique appointment source identity and the existing exclusion constraint. Record policy outcome on the inbound message before effects and distinguish queue handoff from provider delivery. Revalidate approved drafts from the same contract and retain the dashboard's independent human composer.

**Alternatives** Numeric and citation filters alone cannot validate which amount or status applies to which resource. Free-form model replies followed by a second model verdict would retain the same authority problem. Requiring approval for every turn would displace routine automated help.

**Consequences** Unsupported material statements become review work. Automatic text is limited to trusted rendering, fixed conversational responses and safe clarification. Distinct provider delivery recovery remains in G1-08. Stopped turns are reviewable using durable inbound, order and appointment records. See the [contract](../g1/ai-decision-contract.md).

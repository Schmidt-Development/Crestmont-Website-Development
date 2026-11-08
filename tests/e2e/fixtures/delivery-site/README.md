# Website Delivery E2E fixture (synthetic)

A small, hand-written static website used ONLY to test **website delivery** on staging: that a finished build
with a stored snapshot can be assigned to an existing customer project, opened by that customer through the
signed preview capability, and refused to everyone else.

It is **not** output of the AI Website Builder (Model A / Model B) and must never be presented as evidence that
the builder generated a website. Every page says so on screen.

`scripts/staging-delivery-fixture.ts` stores these files as one immutable revision snapshot of the synthetic build
`bld_e2e00000000000000000de11`. This README is not part of the snapshot.

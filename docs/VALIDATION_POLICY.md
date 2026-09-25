# Validation policy

## Objective

The objective is to obtain a complete, auditable catalog of all wager choices and special wager mechanisms exposed by every supplied game.

"Wager choices" includes:

- ordinary selectable bet values;
- line/factor combinations that change effective stake;
- ante bet / booster modes;
- feature-buy modes;
- fixed-price buys;
- other actions that materially change the stake or purchase a game state.

## Status vocabulary

### DECLARED

The provider protocol explicitly declares the option.

### VISUALLY_MAPPED

The option has been located in a screenshot and mapped to a real visible control.

### VALIDATED_NATIVE

A real browser/UI action produced the expected request and the server accepted it.

### VALIDATED_REQUEST_RECOGNIZED

A real UI action produced the expected semantic request, but execution could not complete for a non-structural reason such as demo funds. The server nevertheless recognized the action.

### REQUIRES_REVIEW

Something remains structurally unexplained.

### DEFERRED_PROVIDER_BLOCK

Runtime proof was deferred because the provider started returning blocking/rate-limit responses.

## Completeness rules

A game may be catalog-complete from protocol evidence even while some runtime validations are pending.

A game is runtime-complete only when every special wager option that requires UI mapping has been causally validated or explicitly documented as impossible to exercise in the demo environment.

Normal bet values are cataloged from authoritative bootstrap configuration. Representative visual checks should confirm that UI changes track the declared sequence, but it is not necessary to burn one paid/demo spin for every numeric bet value when the UI and protocol expose the same deterministic list.

Special modes are stricter:

- every buy mode must remain individually represented;
- every booster/ante-bet mode must remain individually represented;
- mode IDs must not be inferred from zero-based UI indexes unless captured request evidence proves that mapping;
- a failed hook cannot negate a declaration.

## Visual-first runtime proof

When validating an economic action:

1. capture screenshot;
2. identify visible control;
3. record coordinates;
4. mark network sequence;
5. click via `page.mouse.click`;
6. collect the post-click network slice;
7. capture next screenshot;
8. reconcile request semantics and visible transition.

Internal methods may be used to diagnose why a control exists, but not as the main validation action.

## Avoid false negatives

Past false negatives came from:

- treating `TestActions.playBuyFeature(0)` as the first provider mode when the provider mode was actually `1`;
- assuming all client families implement `TestActions` the same way;
- waiting for total `network-idle` on WebGL clients that keep background requests open;
- interpreting a failed automation hook as "feature does not exist";
- creating too many fresh sessions and triggering provider blocking.

These must not be reintroduced.

## Provider blocking

If 403/429 blocking appears:

- stop runtime actions quickly;
- preserve discovery results;
- emit retry targets;
- do not mark declarations invalid;
- retry in a different bounded run rather than hammering the provider.

## Unknown actions

Unknown economic-looking actions such as `set_params` require review.

They are not ignored just because normal spin/buy fields were understood.

## Acceptance criterion for this project phase

For the current 3 Oaks target list:

1. every target has a complete normal bet catalog;
2. every declared buy/booster is present;
3. every unexplained action is explicitly listed;
4. repeated UI layouts have a visually verified profile;
5. every special mode is runtime validated by real click evidence where the demo permits it;
6. final artifacts merge the full target set without silently dropping failures.

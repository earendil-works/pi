# Pi Model Availability

This context distinguishes the complete model catalog known to Pi from the models an authenticated account may actually select.

## Language

**Model catalog**:
The complete set of models known to Pi for a provider, independent of the active credential.
_Avoid_: Available models

**Account-selectable model**:
A catalog model that the provider explicitly advertises as usable by the authenticated account.
_Avoid_: Supported model, known model

**Picker catalog**:
The provider's account-specific set of models explicitly intended for interactive selection.
_Avoid_: Model catalog

**Policy-enabled model**:
A model whose account policy explicitly grants access.
_Avoid_: Not-disabled model

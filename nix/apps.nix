{ pi }:

let
  app = {
    type = "app";
    program = "${pi}/bin/pi";
    meta = {
      description = "Minimal terminal coding harness";
    };
  };
in
{
  default = app;
  pi = app;
}

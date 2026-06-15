{ pkgs }:

if pkgs ? nodejs_24 then
  pkgs.nodejs_24
else if pkgs ? nodejs_22 then
  pkgs.nodejs_22
else
  pkgs.nodejs_latest

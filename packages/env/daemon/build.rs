//! Exposes the npm package version as `PI_ENV_VERSION`, so `hello` reports the release the daemon shipped with.

fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    let package = std::fs::read_to_string("../package.json").expect("read ../package.json");
    let version = package
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .expect("version in ../package.json");
    println!("cargo:rustc-env=PI_ENV_VERSION={version}");
}

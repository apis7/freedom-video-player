// Prevents additional console window on Windows in release; ignored in debug.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fvp_lib::run()
}

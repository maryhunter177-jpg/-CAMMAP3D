import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
const result = spawnSync('cargo', ['build','--manifest-path','rust/Cargo.toml','--target','wasm32-unknown-unknown','--release'], { stdio:'inherit' });
if (result.error || result.status !== 0) { console.error('Instale Rust e execute: rustup target add wasm32-unknown-unknown'); process.exit(1); }
mkdirSync('public/wasm', {recursive:true});
copyFileSync('rust/target/wasm32-unknown-unknown/release/cammap_filters.wasm','public/wasm/cammap_filters.wasm');

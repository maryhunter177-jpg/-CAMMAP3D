// Browser owns this single-threaded module; pointers remain stable for its lifetime.
static mut INPUT: [f32; 128] = [0.0; 128];
static mut OUTPUT: [f32; 128] = [0.0; 128];
#[no_mangle]
pub extern "C" fn input_ptr() -> *mut f32 { core::ptr::addr_of_mut!(INPUT).cast() }
#[no_mangle]
pub extern "C" fn output_ptr() -> *mut f32 { core::ptr::addr_of_mut!(OUTPUT).cast() }
#[no_mangle]
pub extern "C" fn reset() { unsafe { OUTPUT = [0.0; 128]; } }
#[no_mangle]
pub extern "C" fn step(n: usize, alpha: f32) {
    let a = alpha.clamp(0.0, 1.0);
    for i in 0..n.min(128) { unsafe { OUTPUT[i] += (INPUT[i] - OUTPUT[i]) * a; } }
}

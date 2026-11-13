use odd::is_odd;

#[test]
fn odd_numbers_are_odd() {
    assert!(is_odd(1));
    assert!(is_odd(7));
}

#[test]
fn even_numbers_are_not_odd() {
    assert!(!is_odd(2));
    assert!(!is_odd(8));
}
package leap

import "testing"

func TestLeapYear(t *testing.T) {
	if !IsLeapYear(2000) {
		t.Error("2000 is a leap year")
	}
	if IsLeapYear(1900) {
		t.Error("1900 is not a leap year")
	}
}
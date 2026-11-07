#!/usr/bin/perl
# Removes ADR citations in brackets from the named files in place; with no files, runs its own checks.
use strict;
use utf8;
use open qw(:std :utf8);

my $n = qr/ADR-\d{4}(?:・\d{4})*/;

sub strip {
  local $_ = shift;
  s/（$n(?:、$n)*）//g;
  s/ ?\($n\)//g;
  s/[、。]$n(?=）)//g;
  s/（$n、/（/g;
  return $_;
}

if (!@ARGV) {
  my @cases = (
    ['ptyd に送る（ADR-0015）。', 'ptyd に送る。'],
    ['二つ（ADR-0009、ADR-0015）。', '二つ。'],
    ['束ねた（ADR-0016・0018）。', '束ねた。'],
    ['/// Process (ADR-0040), or', '/// Process, or'],
    ['（`keys.ts`、ADR-0041・0043）', '（`keys.ts`）'],
    ['（同じ呼び方。ADR-0034）', '（同じ呼び方）'],
    ['（ADR-0037、`packages/usage/src`）', '（`packages/usage/src`）'],
    ['ADR-0016 にある。', 'ADR-0016 にある。'],
  );
  for (@cases) {
    my ($in, $want) = @$_;
    my $got = strip($in);
    die "strip($in) = $got, want $want\n" if $got ne $want;
  }
  print "ok\n";
  exit;
}

$^I = '';
while (<>) { print strip($_) }

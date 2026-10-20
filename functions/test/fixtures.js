'use strict';
// SYNTHETIC data that reproduces the quirks of the real exports. Never put real exports here.

const PRECINCT_HEADER = 'ShallowCopy,CountyPrecinctNum,CountyPrecinctNum_String,PrecinctName,Formated_Precinct_Name,isValid,StateSenateDistrict_String,StateSenateDistrict,StateHouseDistrict_String,StateHouseDistrict,CountyCommissionDistrict_String,CountyCommissionDistrict,SchoolDistrict_String,SchoolDistrict,PollingPlaceID,PollingPlaceName,PollingPlaceAddress,PollingPlaceMailingAddress,DisplayPrecicnt,IsSelected,VoterCount';

// Address fields contain one UNQUOTED comma each, so every row has 23 fields for 21 headers.
const prow = (cpn, name, building, addr, mail) =>
  `X,${cpn},${cpn},${name},F,False,,0,,0,,0,,0,0,${building},${addr},${mail},,False,0`;

const PRECINCT_CSV = [
  PRECINCT_HEADER,
  prow(1, 'ALPHA A', 'HALL ONE', '1 TEST ST, TESTVILLE  TN 37000', 'PO BOX 1, TESTVILLE TN 37001'),
  prow(2, 'ALPHA B', 'HALL ONE', '1 TEST ST, TESTVILLE  TN 37000', 'PO BOX 1, TESTVILLE TN 37001'),
  prow(3, 'BETA', 'HALL TWO', '2 TEST ST, TESTVILLE TN 37000', '2 TEST ST, TESTVILLE TN 37000'),
  prow(4, 'GAMMA B', 'HALL THREE', '3 TEST ST, TESTVILLE TN 37000-1234', 'PO BOX 3, TESTVILLE TN 37001'),
  prow(5, 'EMPTY', 'HALL FOUR', '4 TEST ST, TESTVILLE TN 37000', 'PO BOX 4, TESTVILLE TN 37001')
].join('\r\n') + '\r\n';

const MACHINE_HEADER = 'Account,CPN,Precinct,Machine,Serial Number,Ballot box lid SN,DOE,ElectionName,Polling Place';
const mrow = (cpn, precinct, machine, serial, lid, doe = '3/9/2027', name = 'Test General Election', pp = precinct) =>
  `ACC,${cpn},${precinct},${machine},${serial},${lid},${doe},${name},${pp}`;

const MACHINE_CSV = '﻿' + [
  MACHINE_HEADER,
  mrow(1, 'Alpha A', '', 'DS-1', 'ZZ1001'),
  mrow(2, 'Alpha B', '', 'DS-2', 'ZZ1002'),
  mrow(3, 'Beta', '1', 'DS-3', 'ZZ1003'),
  mrow(3, 'Beta', '2', 'DS-4', 'zz1004'),
  mrow('', 'Gamma B', '', 'DS-5', ' ZZ1005 '),
  mrow(4, 'Gamma B', '', 'DS-6', ''),   // no lid SN -> skipped
  ',,,,,,,',                              // blank trailing row
  ',,,,,,,'
].join('\r\n') + '\r\n';

module.exports = { PRECINCT_CSV, MACHINE_CSV, MACHINE_HEADER, PRECINCT_HEADER, prow, mrow };

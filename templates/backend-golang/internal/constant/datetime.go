package constant

import "time"

const (
	TimeZoneWIB  = "Asia/Jakarta"
	TimeZoneWITA = "Asia/Makassar"
	TimeZoneWIT  = "Asia/Jayapura"
)

var (
	MonthInIndo = map[string]string{
		time.January.String():   "Januari",
		time.February.String():  "Februari",
		time.March.String():     "Maret",
		time.April.String():     "April",
		time.May.String():       "Mei",
		time.June.String():      "Juni",
		time.July.String():      "Juli",
		time.August.String():    "Agustus",
		time.September.String(): "September",
		time.October.String():   "Oktober",
		time.November.String():  "November",
		time.December.String():  "Desember",
	}
	DaysInIndoFrom = map[string]string{
		time.Sunday.String():    "Minggu",
		time.Monday.String():    "Senin",
		time.Tuesday.String():   "Selasa",
		time.Wednesday.String(): "Rabu",
		time.Thursday.String():  "Kamis",
		time.Friday.String():    "Jum'at",
		time.Saturday.String():  "Sabtu",
	}
)

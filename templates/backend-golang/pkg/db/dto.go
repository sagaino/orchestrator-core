package db

import (
	"database/sql"
	"time"
)

var (
	NullTime = func(input time.Time) sql.NullTime {
		return sql.NullTime{Time: input, Valid: true}
	}
)

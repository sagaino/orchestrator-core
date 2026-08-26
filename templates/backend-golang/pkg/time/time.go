//go:generate mockery --all --inpackage --case snake

package time

import (
	"context"
	"log"
	"time"
)

var CtxKeyTimezone = "time.location"

type clock struct {
}

type Clock interface {
	ParseWithTzFromCtx(ctx context.Context, value string, format string) time.Time
	Now(ctx context.Context) time.Time
	NowUnix() int64
	GetTimeZoneByName(name string) *time.Location
	SetTimezoneToContext(ctx context.Context, val string) context.Context
	GetTimezoneFromContext(ctx context.Context) *time.Location
}

func Default() Clock {
	return &clock{}
}

func (t clock) SetTimezoneToContext(ctx context.Context, val string) context.Context {
	if val == "" {
		return context.WithValue(ctx, CtxKeyTimezone, time.UTC)
	}
	tz, _ := time.LoadLocation(val)
	return context.WithValue(ctx, CtxKeyTimezone, *tz)
}

func (t clock) GetTimezoneFromContext(ctx context.Context) *time.Location {
	lz := time.UTC
	if ct, ok := ctx.Value(CtxKeyTimezone).(time.Location); ok {
		lz = &ct
	}
	return lz
}

func (t clock) GetTimeZoneByName(name string) *time.Location {
	tz, err := time.LoadLocation(name)
	if err != nil {

		log.Println("err GetTimeZoneByName: %w", err)
		return time.UTC
	}
	return tz
}

func (t clock) Now(ctx context.Context) time.Time {
	lz := t.GetTimezoneFromContext(ctx)
	return time.Now().In(lz)
}

func (t clock) ParseWithTzFromCtx(ctx context.Context, layout string, value string) time.Time {
	lz := t.GetTimezoneFromContext(ctx)
	date, err := time.ParseInLocation(layout, value, lz)
	if err != nil {
		return time.Time{}
	}

	return date
}

func (t clock) NowUnix() int64 {
	return time.Now().Unix()
}

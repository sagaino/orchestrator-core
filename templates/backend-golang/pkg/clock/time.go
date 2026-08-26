//go:generate mockery --all --inpackage --case snake

package clock

import (
	"base-be-golang/shared/payload"
	"context"
	"fmt"
	"time"
)

type CLOCK struct {
}

func (t CLOCK) SetTimezoneToContext(ctx context.Context, val string) context.Context {
	//TODO implement me
	panic("implement me")
}

func Default() CLOCK {
	return CLOCK{}
}

func (t CLOCK) GetTimezoneFromContext(ctx context.Context) *time.Location {
	var lz = time.UTC
	if pd, ok := ctx.Value(payload.AuthCodeContext).(payload.UserData); ok {
		lz = pd.Tz
	}
	return lz
}

func (t CLOCK) GetTimeZoneByName(name string) *time.Location {
	tz, err := time.LoadLocation(name)
	if err != nil {

		fmt.Println("err GetTimeZoneByName: %w", err)
		return time.UTC
	}
	return tz
}

func (t CLOCK) Now(ctx context.Context) time.Time {
	lz := t.GetTimezoneFromContext(ctx)
	return time.Now().In(lz)
}

func (t CLOCK) NowUTC() time.Time {
	return time.Now().UTC()
}

func (t CLOCK) ParseWithTzFromCtx(ctx context.Context, layout string, value string) time.Time {
	lz := t.GetTimezoneFromContext(ctx)
	date, err := time.ParseInLocation(layout, value, lz)
	if err != nil {
		return time.Time{}
	}

	return date
}

func (t CLOCK) NowUnix() int64 {
	return time.Now().Unix()
}

package inetproto

import "reflect"

var (
	TypeIsInt = []reflect.Kind{
		reflect.Int,
		reflect.Int8,
		reflect.Int16,
		reflect.Int32,
		reflect.Int64,
	}

	TypeIsFloat = []reflect.Kind{
		reflect.Float64,
		reflect.Float32,
	}

	TypeIsUint = []reflect.Kind{
		reflect.Uint,
		reflect.Uint8,
		reflect.Uint16,
		reflect.Uint32,
		reflect.Uint64,
	}
)
